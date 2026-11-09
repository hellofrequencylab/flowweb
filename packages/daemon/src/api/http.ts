// HTTP plumbing for the local API: the response envelope, typed errors, JSON bodies and paging.
// Contract: docs/api/LOCAL-API-V1.md.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Reader } from '@fw/eventlog';

export type ErrorCode =
  | 'not_found'
  | 'validation_failed'
  | 'kill_switch_engaged'
  | 'stale_hash'
  | 'unauthorized'
  | 'internal'
  | 'not_implemented'
  | 'forbidden'
  | 'method_not_allowed';

/** Thrown by a handler; the router turns it into `{ error: { code, message, details } }`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  constructor(status: number, code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what: string, id?: string): ApiError =>
  new ApiError(404, 'not_found', id === undefined ? `${what} not found` : `${what} ${id} not found`);

export const invalid = (message: string, details: Record<string, unknown> = {}): ApiError =>
  new ApiError(400, 'validation_failed', message, details);

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

export function sendError(res: ServerResponse, err: ApiError, headers: Record<string, string> = {}): void {
  sendJson(
    res,
    err.status,
    { error: { code: err.code, message: err.message, details: err.details } },
    headers,
  );
}

export function headSeq(reader: Reader): number {
  return reader.get<{ s: number | null }>('SELECT MAX(seq) AS s FROM events')?.s ?? 0;
}

export interface Envelope {
  data: unknown;
  as_of: string;
  head_seq: number;
  next_cursor: string | null;
}

/** Reads head_seq first, so the data is never older than the head it is labelled with. */
export function envelope(
  reader: Reader,
  read: () => { data: unknown; next_cursor?: string | null },
): Envelope {
  const as_of = new Date().toISOString();
  const head_seq = headSeq(reader);
  const { data, next_cursor = null } = read();
  return { data, as_of, head_seq, next_cursor };
}

const MAX_BODY = 16 * 1024;

/** Reads a small JSON object body. Requires `content-type: application/json` (a plain form post cannot send it). */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') throw invalid('content-type must be application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > MAX_BODY) throw invalid('request body too large');
    chunks.push(b);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw invalid('request body is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalid('request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

// ---- paging -------------------------------------------------------------------------------

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export interface Page {
  limit: number;
  offset: number;
}

/** `?limit=` (default 50, capped at 200) and an opaque offset `?cursor=`. */
export function limitOf(q: URLSearchParams): number {
  const raw = q.get('limit');
  if (raw === null || raw === '') return DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw invalid('limit must be a positive integer');
  return Math.min(Number(raw), MAX_LIMIT);
}

export function pageOf(q: URLSearchParams): Page {
  const limit = limitOf(q);
  const cursor = q.get('cursor');
  let offset = 0;
  if (cursor !== null && cursor !== '') {
    const m = /^o(\d{1,9})$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!m) throw invalid('cursor is not one this daemon issued');
    offset = Number(m[1]);
  }
  return { limit, offset };
}

/** Runs a query with LIMIT limit+1 OFFSET offset and returns the page plus the next cursor. */
export function paged<T>(
  page: Page,
  query: (limit: number, offset: number) => T[],
): { data: T[]; next_cursor: string | null } {
  const rows = query(page.limit + 1, page.offset);
  const more = rows.length > page.limit;
  const data = more ? rows.slice(0, page.limit) : rows;
  const next_cursor = more ? Buffer.from(`o${page.offset + page.limit}`).toString('base64url') : null;
  return { data, next_cursor };
}

export function oneOf<T extends string>(
  q: URLSearchParams,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const v = q.get(name);
  if (v === null || v === '') return undefined;
  if (!(allowed as readonly string[]).includes(v)) {
    throw invalid(`${name} must be one of ${allowed.join(', ')}`, { [name]: v });
  }
  return v as T;
}

export function nonNegInt(q: URLSearchParams, name: string): number | undefined {
  const v = q.get(name);
  if (v === null || v === '') return undefined;
  if (!/^\d+$/.test(v)) throw invalid(`${name} must be a non-negative integer`, { [name]: v });
  return Number(v);
}

export function isoParam(q: URLSearchParams, name: string): string | undefined {
  const v = q.get(name);
  if (v === null || v === '') return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw invalid(`${name} must be an ISO-8601 timestamp`, { [name]: v });
  return d.toISOString();
}
