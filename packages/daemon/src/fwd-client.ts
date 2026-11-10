// The client side of fwd's loopback API, for the in-process core client (local-client.ts): finds fwd
// for an FW_HOME (port from FW_PORT, else the default; the CLI token from
// $FW_HOME/pairing/cli.token, which fwd writes) and sends one JSON request to it.
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';

const LOOPBACK = '127.0.0.1';
/** fwd's default port; the same figure as DEFAULT_PORT in daemon.ts (not imported, to stay light). */
const FWD_DEFAULT_PORT = 7317;

export interface FwdEndpoint {
  port: number;
  /** undefined when fwd never wrote a CLI token in this home (so no fwd ever ran here). */
  token: string | undefined;
}

export function fwdEndpoint(home: string, env: NodeJS.ProcessEnv = process.env): FwdEndpoint {
  const raw = env.FW_PORT;
  const port =
    raw && /^\d+$/.test(raw) && Number(raw) > 0 && Number(raw) <= 65535 ? Number(raw) : FWD_DEFAULT_PORT;
  let token: string | undefined;
  try {
    token = readFileSync(join(home, 'pairing', 'cli.token'), 'utf8').trim() || undefined;
  } catch {
    token = undefined;
  }
  return { port, token };
}

/** fwd could not be reached at all (nothing listening, connection reset before an answer). */
export class FwdUnreachableError extends Error {
  readonly code = 'DAEMON_UNREACHABLE';
}

export interface FwdResponse {
  status: number;
  body: Record<string, unknown>;
}

/**
 * One request to fwd. Resolves with any HTTP answer; rejects with FwdUnreachableError when there is
 * none. timeoutMs 0 waits as long as the request takes (a hosted run answers when the run ends).
 */
export function fwdRequest(
  ep: FwdEndpoint,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  timeoutMs = 0,
): Promise<FwdResponse> {
  const text = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((ok, fail) => {
    const req = request(
      {
        host: LOOPBACK,
        port: ep.port,
        path,
        method,
        headers: {
          accept: 'application/json',
          ...(ep.token ? { authorization: `Bearer ${ep.token}` } : {}),
          ...(text === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }),
        },
        // No shared agent: Node's global agent puts a 5 s idle timeout on its sockets, which would
        // end a long call (a close running its probe, a hosted run) as if fwd never answered.
        agent: false,
        ...(timeoutMs > 0 ? { timeout: timeoutMs } : {}),
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => {
          data += d;
        });
        res.on('error', (e) => fail(new FwdUnreachableError(`fwd answer cut off: ${e.message}`)));
        res.on('end', () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data || '{}');
          } catch {
            parsed = {
              error: { code: 'internal', message: `fwd answered non-JSON (HTTP ${res.statusCode})` },
            };
          }
          ok({
            status: res.statusCode ?? 0,
            body: parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {},
          });
        });
      },
    );
    if (timeoutMs > 0) req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    req.on('error', (e) =>
      fail(new FwdUnreachableError(`fwd not reachable on ${LOOPBACK}:${ep.port}: ${e.message}`)),
    );
    req.end(text);
  });
}

/** An error answer from fwd, as an Error whose code is the kernel's own (details.fw_code) when given. */
export function fwdError(res: FwdResponse): Error & { code: string; details: Record<string, unknown> } {
  const e = (res.body.error ?? {}) as { code?: unknown; message?: unknown; details?: unknown };
  const details = e.details && typeof e.details === 'object' ? (e.details as Record<string, unknown>) : {};
  const code =
    typeof details.fw_code === 'string'
      ? details.fw_code
      : typeof e.code === 'string'
        ? `DAEMON_${e.code.toUpperCase()}`
        : 'DAEMON_ERROR';
  const message = typeof e.message === 'string' ? e.message : `fwd answered HTTP ${res.status}`;
  return Object.assign(new Error(`fwd: ${message}`), { code, details });
}
