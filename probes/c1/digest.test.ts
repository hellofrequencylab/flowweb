// Probe c1/digest (FW-C-023; backlog verify_probe workstreams/digest).
// Surfaces: the query registry exported by packages/ledger/src/index.ts and the digest exported by
// packages/daemon/src/index.ts, driven with the Store writer and reader of a real FW_HOME after
// `fw ledger sync`; the status_reports table and the digest.published and digest.rejected events of
// schema.core.sql, read with node:sqlite read-only; @fw/contracts `validate` for status-report.json.
// The exports this probe expects (no spec names them; see probes/c1/README.md, "Decisions" 46-50):
//   QUERIES: [{ id, sql, ... }] (read-only, parameterised by :project, :from, :to)
//   runQuery(reader, id, { project, from, to }) -> { rows, result_hash }
//   buildDigest(reader, { project?, from, to }) -> a status-report.json body; every line (headline,
//     done, next, blocked, risks) cites one or more query ids as "[q:<id>]"
//   checkDigest(reader, report) -> { ok, problems: [{ where, reason: 'uncited' | 'mismatch' | ... }] }
//   publishDigest(writer, { project?, from, to, narrative?, report? }) -> { published, report_id?,
//     problems }: checks the report (the given one, else the built one) and only then writes a
//     status_reports row and digest.published; a failing report writes digest.rejected and no row.
//     A narrative replaces the headline only if it passes the same check.
// Acceptance (FW-C-023):
//   1. a digest with an uncited line fails its check and is not published
//   2. recomputing each cited query reproduces every number (this probe recomputes them itself)
//   3. when nothing changed overnight the report says so plainly
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { count, fail, fixtureProject, fw, freshHome, openDbReadonly, requireExport, root } from '../c0/_lib.mjs';

type Line = { text: string };
type Report = Record<string, unknown> & {
  id: string;
  headline: string;
  done: Line[];
  next: Line[];
  blocked: Line[];
  risks: Line[];
  period: { from: string; to: string };
  project_id: string;
};
type Fn = (...a: unknown[]) => any;
const ROW = 'FW-C-023';
const CITE = /\[q:([a-z0-9_]+)\]/g;

const lines = (r: Report) => [
  { where: 'headline', text: r.headline },
  ...(['done', 'next', 'blocked', 'risks'] as const).flatMap((k) => r[k].map((l, i) => ({ where: `${k}[${i}]`, text: l.text }))),
];
/** The numbers a line states, with citations and ISO timestamps left out. */
const numbers = (text: string) =>
  text
    .replace(CITE, ' ')
    .replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, ' ')
    .match(/-?\d+(?:\.\d+)?/g)
    ?.map(Number) ?? [];

describe('c1/digest', () => {
  test('digests cite queries, recompute, say when nothing changed, and an uncited one is not published', async () => {
    const QUERIES = (await requireExport('ledger', 'QUERIES', ROW)) as { id: string; sql: string }[];
    const runQuery = (await requireExport('ledger', 'runQuery', ROW)) as Fn;
    const buildDigest = (await requireExport('daemon', 'buildDigest', ROW)) as Fn;
    const checkDigest = (await requireExport('daemon', 'checkDigest', ROW)) as Fn;
    const publishDigest = (await requireExport('daemon', 'publishDigest', ROW)) as Fn;
    const { openStore } = await import(pathToFileURL(join(root, 'packages/eventlog/src/index.ts')).href);
    const { validate } = await import(pathToFileURL(join(root, 'packages/contracts/src/index.ts')).href);

    for (const q of QUERIES) if (!/^\s*(SELECT|WITH)\b/i.test(q.sql)) fail(`query ${q.id} is not a read-only SELECT`);

    const home = freshHome('c1-digest');
    const proj = fixtureProject({ rowId: 'FW-C-968', extraRows: [{ id: 'FW-C-969' }] });
    expect(fw(['ledger', 'sync', '--json'], { home, cwd: proj.work }).status, 'fw ledger sync').toBe(0);
    const store = openStore({ path: join(home, 'db', 'fw.sqlite'), lockPath: join(home, 'fwd.lock') });
    try {
      const r = store.reader();
      const now = Date.now();
      const iso = (ms: number) => new Date(ms).toISOString();
      const busy = { from: iso(now - 24 * 3600_000), to: iso(now + 60_000) };
      const quiet = { from: iso(now + 3600_000), to: iso(now + 9 * 3600_000) };

      // Acceptance 2: every line cites a registered query and every number recomputes.
      const recompute = (report: Report) => {
        for (const l of lines(report)) {
          const ids = [...l.text.matchAll(CITE)].map((m) => m[1]!);
          if (ids.length === 0) fail(`${l.where} cites no query: ${l.text}`);
          const values = new Set<number>();
          for (const id of ids) {
            if (!QUERIES.some((q) => q.id === id)) fail(`${l.where} cites ${id}, which is not in QUERIES`);
            const res = runQuery(r, id, { project: report.project_id, from: report.period.from, to: report.period.to });
            for (const row of res.rows as Record<string, unknown>[])
              for (const v of Object.values(row)) if (typeof v === 'number') values.add(v);
          }
          for (const n of numbers(l.text))
            if (!values.has(n)) fail(`${l.where}: ${n} is not reproduced by ${ids.join(', ')} (${[...values].join(', ')}): ${l.text}`);
        }
      };
      const day = buildDigest(r, busy) as Report;
      const errs = validate('status-report', day).errors;
      if (errs.length) fail(`the digest is not a valid status-report: ${JSON.stringify(errs).slice(0, 300)}`);
      recompute(day);
      expect(numbers(lines(day).map((l) => l.text).join(' ')).includes(2), 'the busy day reports the 2 synced rows').toBe(true);
      expect(checkDigest(r, day).ok, 'the built digest passes its own check').toBe(true);

      // Acceptance 3: a quiet night says so in the headline, and still cites and recomputes.
      const night = buildDigest(r, quiet) as Report;
      expect(night.headline).toMatch(/nothing changed/i);
      recompute(night);

      // Acceptance 1: an uncited line (or a wrong number) fails the check and is not published.
      const uncited = { ...day, id: 'rpt_probeuncited01', done: [...day.done, { text: 'Shipped the whole roadmap overnight' }] };
      const c1 = checkDigest(r, uncited);
      expect(c1.ok).toBe(false);
      expect(c1.problems.map((p: { reason: string }) => p.reason)).toContain('uncited');
      const wrong = { ...day, id: 'rpt_probewrong001', headline: `${day.headline.replace(/\d+/, '9999')}` };
      if (/9999/.test(wrong.headline)) expect(checkDigest(r, wrong).problems.map((p: { reason: string }) => p.reason)).toContain('mismatch');

      const before = count(store.reader() as never, 'SELECT count(*) AS n FROM status_reports');
      void before;
      const refused = await publishDigest(store.writer, { ...busy, report: uncited });
      expect(refused.published, 'an uncited digest is not published').toBe(false);

      const viaNarrative = await publishDigest(store.writer, { ...busy, narrative: 'A great night: everything moved forward.' });
      expect(viaNarrative.published, 'the template renders when the narrative cites nothing').toBe(true);
      const ok = await publishDigest(store.writer, quiet);
      expect(ok.published).toBe(true);
    } finally {
      store.close();
    }

    const db = await openDbReadonly(home);
    const reports = db.prepare('SELECT id, body FROM status_reports').all() as { id: string; body: string }[];
    const published = db.prepare("SELECT payload FROM events WHERE type = 'digest.published'").all() as { payload: string }[];
    const rejected = db.prepare("SELECT payload FROM events WHERE type = 'digest.rejected'").all() as { payload: string }[];
    db.close();
    expect(reports.length, 'two digests published (narrative fallback and the quiet night)').toBe(2);
    expect(reports.some((x) => x.id === 'rpt_probeuncited01'), 'the uncited digest has no row').toBe(false);
    for (const x of reports) {
      const body = JSON.parse(x.body) as Report;
      expect(body.headline).not.toMatch(/great night/);
      for (const l of lines(body)) if (!/\[q:[a-z0-9_]+\]/.test(l.text)) fail(`published ${x.id} has an uncited line: ${l.text}`);
    }
    expect(published.map((p) => JSON.parse(p.payload).recompute_matched)).toEqual([true, true]);
    expect(rejected.length, 'one digest.rejected for the uncited digest').toBe(1);
    expect(JSON.parse(rejected[0]!.payload).reason).toBe('missing_query_id');
  });
});
