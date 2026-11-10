// The digest stream (FW-C-023): a status-report built only from registered queries. Every line cites the
// queries it came from as `[q:<id>]`, and every number in it must be reproduced by re-running those queries
// over the report's project and period. A report that fails that check is never stored: publishing records
// digest.rejected instead. A narrative headline is used only when it passes the same check.
import { validate } from '@fw/contracts';
import { newId, nowIso, type Reader, type Writer } from '@fw/eventlog';
import { DEFAULT_AGENTS, findQuery, runQuery } from '@fw/ledger';

const ACTOR = { actor_kind: 'system', actor_id: 'fwd.digest' } as const;
const CITE = /\[q:([a-z0-9_]+)\]/g;
const ISO = /\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g;

export interface DigestLine {
  text: string;
  ledger_row_id?: string;
  needs?: 'owner' | 'chief_of_staff' | 'external' | 'dependency';
}

export interface DigestReport {
  id: string;
  reporter_agent_id: string;
  project_id: string;
  kind: 'daily';
  period: { from: string; to: string };
  headline: string;
  done: DigestLine[];
  next: DigestLine[];
  blocked: DigestLine[];
  risks: DigestLine[];
  spend: { usd: number; pct_of_budget: number; tokens: number; query_id: string };
  wip: { active: number; limit: number };
  data_as_of: string;
  [k: string]: unknown;
}

export type DigestProblemReason = 'uncited' | 'unknown_query' | 'mismatch' | 'invalid';

export interface DigestProblem {
  where: string;
  reason: DigestProblemReason;
  detail: string;
}

export interface DigestCheck {
  ok: boolean;
  problems: DigestProblem[];
  figure_count: number;
}

export interface DigestOptions {
  project?: string;
  from: string;
  to: string;
}

export interface PublishOptions extends DigestOptions {
  /** A Chief of Staff headline; used only if it cites and recomputes like any other line. */
  narrative?: string;
  /** A report built elsewhere; checked before anything is stored. */
  report?: DigestReport;
}

export interface PublishResult {
  published: boolean;
  report_id?: string;
  used_narrative: boolean;
  problems: DigestProblem[];
}

function projectFor(r: Reader, project: string | undefined): string {
  if (project) return project;
  const all = r.all<{ id: string }>('SELECT id FROM projects ORDER BY created_at');
  if (all.length !== 1) throw new Error('digest: name the project (this home has more or fewer than one)');
  return all[0]!.id;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Builds the template digest. Every line comes from a registered query; no free text. */
export function buildDigest(r: Reader, opts: DigestOptions): DigestReport {
  const project = projectFor(r, opts.project);
  const p = { project, from: opts.from, to: opts.to };
  const one = (id: string) => (runQuery(r, id, p).rows[0] ?? {}) as Record<string, number>;
  const a = one('activity');
  const s = one('row_status');
  const spend = one('spend');
  const wip = one('wip');

  const quiet = (a.events ?? 0) === 0;
  const headline = quiet
    ? 'Nothing changed in this period: 0 events recorded [q:activity]'
    : `${plural(a.events!, 'event', 'events')}: ${a.rows_created} rows added, ${a.rows_done} done, ${a.runs_failed} runs failed [q:activity]`;

  const done: DigestLine[] = [];
  if (a.rows_created)
    done.push({ text: `${plural(a.rows_created, 'row', 'rows')} added to the ledger [q:activity]` });
  if (a.rows_done) done.push({ text: `${plural(a.rows_done, 'row', 'rows')} closed as done [q:activity]` });
  if (a.runs_succeeded)
    done.push({ text: `${plural(a.runs_succeeded, 'run', 'runs')} succeeded [q:activity]` });

  const next: DigestLine[] = [];
  if (s.waiting)
    next.push({ text: `${plural(s.waiting, 'row is', 'rows are')} waiting to start [q:row_status]` });
  if (s.in_flight)
    next.push({ text: `${plural(s.in_flight, 'row is', 'rows are')} in flight [q:row_status]` });

  const blocked: DigestLine[] = [];
  if (s.blocked)
    blocked.push({
      text: `${plural(s.blocked, 'row is', 'rows are')} blocked [q:row_status]`,
      needs: 'owner',
    });

  const risks: DigestLine[] = [];
  if (a.runs_failed) risks.push({ text: `${plural(a.runs_failed, 'run', 'runs')} failed [q:activity]` });
  if (s.regressed)
    risks.push({ text: `${plural(s.regressed, 'row', 'rows')} regressed after merge [q:row_status]` });

  return {
    id: newId('rpt'),
    reporter_agent_id: DEFAULT_AGENTS.lead.id,
    project_id: project,
    kind: 'daily',
    period: { from: opts.from, to: opts.to },
    headline,
    done,
    next,
    blocked,
    risks,
    spend: { usd: spend.usd ?? 0, pct_of_budget: 0, tokens: spend.tokens ?? 0, query_id: 'spend' },
    wip: { active: wip.active ?? 0, limit: Math.max(1, wip.wip_limit ?? 1) },
    data_as_of: nowIso(),
  };
}

function lines(report: DigestReport): { where: string; text: string }[] {
  const out = [{ where: 'headline', text: String(report.headline ?? '') }];
  for (const k of ['done', 'next', 'blocked', 'risks'] as const)
    for (const [i, l] of (report[k] ?? []).entries())
      out.push({ where: `${k}[${i}]`, text: String(l?.text ?? '') });
  return out;
}

function numbersIn(text: string): number[] {
  return (
    text
      .replace(CITE, ' ')
      .replace(ISO, ' ')
      .match(/-?\d+(?:\.\d+)?/g)
      ?.map(Number) ?? []
  );
}

/** Checks a report: valid shape, every line cites registered queries, every number recomputes. */
export function checkDigest(r: Reader, report: DigestReport): DigestCheck {
  const problems: DigestProblem[] = [];
  const v = validate('status-report', report);
  for (const e of v.errors)
    problems.push({ where: 'report', reason: 'invalid', detail: JSON.stringify(e).slice(0, 200) });
  const params = { project: report.project_id, from: report.period?.from, to: report.period?.to };
  const cache = new Map<string, Set<number>>();
  const valuesOf = (id: string) => {
    let set = cache.get(id);
    if (!set) {
      set = new Set();
      for (const row of runQuery(r, id, params).rows)
        for (const x of Object.values(row)) if (typeof x === 'number') set.add(x);
      cache.set(id, set);
    }
    return set;
  };
  let figures = 0;
  for (const l of lines(report)) {
    const ids = [...l.text.matchAll(CITE)].map((m) => m[1]!);
    if (ids.length === 0) {
      problems.push({ where: l.where, reason: 'uncited', detail: l.text });
      continue;
    }
    const unknown = ids.filter((id) => !findQuery(id));
    if (unknown.length) {
      problems.push({ where: l.where, reason: 'unknown_query', detail: unknown.join(', ') });
      continue;
    }
    const values = new Set(ids.flatMap((id) => [...valuesOf(id)]));
    for (const n of numbersIn(l.text)) {
      figures++;
      if (!values.has(n))
        problems.push({
          where: l.where,
          reason: 'mismatch',
          detail: `${n} is not reproduced by ${ids.join(', ')}`,
        });
    }
  }
  return { ok: problems.length === 0, problems, figure_count: figures };
}

/**
 * Checks, then publishes: a status_reports row and digest.published in one transaction. A report that fails
 * the check writes digest.rejected and nothing else.
 */
export function publishDigest(w: Writer, opts: PublishOptions): PublishResult {
  let report = opts.report ?? buildDigest(w, opts);
  let usedNarrative = false;
  if (!opts.report && opts.narrative) {
    const candidate = { ...report, headline: opts.narrative };
    if (checkDigest(w, candidate).ok) {
      report = candidate;
      usedNarrative = true;
    }
  }
  return w.transaction((tx) => {
    const check = checkDigest(tx, report);
    if (!check.ok) {
      const uncited = check.problems.some((p) => p.reason === 'uncited' || p.reason === 'unknown_query');
      tx.appendEvent({
        ...ACTOR,
        type: 'digest.rejected',
        project_id: report.project_id ?? null,
        idempotency_key: `${report.id}+rejected`,
        payload: {
          digest_id: report.id,
          kind: 'daily',
          reason: uncited ? 'missing_query_id' : 'mismatch',
          mismatches: check.problems,
        },
      });
      return { published: false, used_narrative: usedNarrative, problems: check.problems };
    }
    tx.run(
      `INSERT INTO status_reports(id, reporter_agent_id, project_id, kind, period_from, period_to, body, data_as_of)
       VALUES (?, ?, ?, 'daily', ?, ?, ?, ?)`,
      [
        report.id,
        report.reporter_agent_id,
        report.project_id,
        report.period.from,
        report.period.to,
        JSON.stringify(report),
        report.data_as_of,
      ],
    );
    tx.appendEvent({
      ...ACTOR,
      type: 'digest.published',
      project_id: report.project_id,
      idempotency_key: report.id,
      payload: {
        digest_id: report.id,
        kind: 'daily',
        figure_count: check.figure_count,
        stale_count: 0,
        failed_count: 0,
        recompute_matched: true,
        data_as_of: report.data_as_of,
      },
    });
    return { published: true, report_id: report.id, used_narrative: usedNarrative, problems: [] };
  });
}
