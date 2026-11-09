// GET /v1/events/stream: server-sent events. Each event row goes out as `event: fw` with
// `id: <seq>`; a client resumes with Last-Event-ID (or ?after_seq=). With neither, the stream
// starts at the current head (only new events). New seqs are found by polling the read-only
// connection; a comment line every heartbeat interval keeps proxies and the browser honest.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { headSeq, invalid } from './http.ts';
import type { ApiDeps } from './routes.ts';
import { JSON_COLUMNS, parseJsonColumns } from './rows.ts';

const BATCH = 500;

function startSeq(req: IncomingMessage, query: URLSearchParams, deps: ApiDeps): number {
  const last = req.headers['last-event-id'];
  const raw = typeof last === 'string' && last !== '' ? last : query.get('after_seq');
  if (raw === null || raw === '') return headSeq(deps.reader);
  if (!/^\d+$/.test(raw)) throw invalid('Last-Event-ID / after_seq must be a non-negative integer');
  return Number(raw);
}

export function streamEvents(
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
  deps: ApiDeps,
): void {
  let last = startSeq(req, query, deps);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(`retry: 2000\n: fwd events from seq ${last}\n\n`);

  let closed = false;
  const flush = () => {
    if (closed) return;
    try {
      for (;;) {
        const rows = deps.reader.all<Record<string, unknown>>(
          'SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?',
          [last, BATCH],
        );
        for (const row of rows) {
          const ev = parseJsonColumns(row, JSON_COLUMNS.events);
          res.write(`id: ${ev.seq}\nevent: fw\ndata: ${JSON.stringify(ev)}\n\n`);
          last = ev.seq as number;
        }
        if (rows.length < BATCH) break;
      }
    } catch {
      end();
    }
  };
  const poll = setInterval(flush, deps.ssePollMs);
  const beat = setInterval(() => {
    if (!closed) res.write(': heartbeat\n\n');
  }, deps.sseHeartbeatMs);
  const untrack = deps.trackStream(() => end());
  function end(): void {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    clearInterval(beat);
    untrack();
    res.end();
  }
  req.on('close', end);
  res.on('error', end);
  flush();
}
