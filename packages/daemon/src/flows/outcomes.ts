// FW-C-055: fwd asks Frequency each day what became of the people a flow reached. Frequency answers a
// signed request (frequency-web /api/webhooks/flowweb-outcomes) with counts per FlowWeb campaign and
// draft, and the four region numbers. fwd keeps only the count fields, writes outcomes.json in the flow's
// folder, and makes the region numbers the regions' measures, as a metrics upload would. A failed pull
// keeps the last good numbers and records why, so an outage never reads as a region going cold.
import { createHmac } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CredentialError, resolveCredential } from '../creds/index.ts';
import { flowRef } from '../overseer/copies.ts';
import { FLOW_KEY, loadFlow } from './neighborhood-activation.ts';
import { importMetrics, writeJsonAtomic } from './neighborhood-admin.ts';

export const OUTCOMES_HANDLE = 'crd_frequencyoutcomes';
const PATH = '/api/webhooks/flowweb-outcomes';
const WINDOW_DAYS = 90;
/** A copy's pull names at most this many of its draft tags. */
const TAGS_MAX = 500;
const DAY = 86_400_000;
const COUNT_FIELDS = ['leads', 'members', 'hosts', 'paid'] as const;
const TAG_FIELDS = ['campaign', 'content', 'medium', 'src'] as const;
const REGION_FIELDS = ['territory_id', 'hosts_active_28d', 'events_next_14d', 'sub_areas_covered_14d', 'wam'];

export type OutcomeRow = Record<(typeof TAG_FIELDS)[number], string | null> &
  Record<(typeof COUNT_FIELDS)[number], number>;
export type LastPull = { ok: boolean; at: string; error?: string };

/** A pull that could not run (409: no secret) or that Frequency refused or never answered (502). */
export class PullError extends Error {
  readonly status: 409 | 502;
  constructor(status: 409 | 502, message: string) {
    super(message);
    this.status = status;
  }
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const dir = (fwHome: string) => join(fwHome, 'flows', FLOW_KEY);

/** Keeps the tag and count fields of one outcome row; anything else (a name, an address) is dropped. */
export function cleanRow(raw: unknown): OutcomeRow | null {
  if (!isObj(raw)) return null;
  const row = {} as OutcomeRow;
  for (const k of TAG_FIELDS)
    row[k] = typeof raw[k] === 'string' && raw[k] !== '' ? (raw[k] as string) : null;
  for (const k of COUNT_FIELDS) {
    const n = raw[k];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return null;
    row[k] = n;
  }
  return row;
}

/** The signature Frequency checks: hex HMAC-SHA256 of `${timestamp}.${body}`. */
export function sign(secret: string, ts: string, body: string): string {
  return createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

/** The tags and hunt ids a copy's own drafts carry: what its pull asks about and keeps. Never throws. */
function draftTags(home: string): { tags: string[]; mine: Set<string> } {
  const tags = new Set<string>();
  const mine = new Set<string>();
  const d = join(dir(home), 'drafts');
  for (const f of existsSync(d) ? readdirSync(d).sort() : []) {
    if (!f.endsWith('.json')) continue;
    try {
      const doc = JSON.parse(readFileSync(join(d, f), 'utf8')) as Record<string, unknown>;
      if (typeof doc.tag === 'string' && doc.tag !== '') tags.add(doc.tag);
      if (typeof doc.hunt_id === 'string' && doc.hunt_id !== '') mine.add(doc.hunt_id);
    } catch {
      // An unreadable draft carries no tag.
    }
  }
  for (const t of tags) mine.add(t);
  return { tags: [...tags].slice(0, TAGS_MAX), mine };
}

/**
 * Pulls for the base flow, or with `flow` for one copy (FW-C-166): the copy's request names the copy and its
 * drafts' tags, and only rows for those tags or its hunts are kept, under the copy's own home. The secret
 * is always read from the root home.
 */
export async function pullOutcomes(o: {
  repoRoot: string;
  fwHome: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  flow?: string;
}): Promise<{ outcomes: number; regions: number }> {
  const now = o.now ?? new Date();
  const at = now.toISOString();
  const copy = o.flow !== undefined && flowRef(o.fwHome, o.flow).copy ? o.flow : null;
  const home = copy ? flowRef(o.fwHome, copy).home : o.fwHome;
  const fail = (status: 409 | 502, message: string): never => {
    writeJsonAtomic(join(dir(home), 'pull.json'), { ok: false, at, error: message } satisfies LastPull);
    throw new PullError(status, message);
  };
  const flow = loadFlow(o.repoRoot, home, now);
  if (!flow) return fail(502, `the ${FLOW_KEY} flow is not in this repo`);
  let secret: string;
  try {
    secret = resolveCredential(OUTCOMES_HANDLE, { home: o.fwHome });
  } catch (e) {
    const why = e instanceof CredentialError ? e.message : String(e);
    return fail(409, `no secret for ${OUTCOMES_HANDLE}: ${why}`);
  }
  const site = (o.env?.FW_FREQUENCY_URL || flow.cfg.offer.url).replace(/\/$/, '');
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY).toISOString();
  const own = copy ? draftTags(home) : null;
  const body = JSON.stringify(own ? { since, flow: copy, tags: own.tags } : { since });
  const ts = String(Math.floor(now.getTime() / 1000));
  let answer: unknown;
  try {
    const res = await fetch(`${site}${PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-flowweb-timestamp': ts,
        'x-flowweb-signature': sign(secret, ts, body),
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return fail(502, `Frequency answered ${res.status}`);
    answer = await res.json();
  } catch (e) {
    return fail(502, `could not reach Frequency: ${(e as Error)?.message ?? e}`);
  }
  if (!isObj(answer) || !Array.isArray(answer.outcomes) || !Array.isArray(answer.regions))
    return fail(502, 'Frequency answered without outcomes and regions');
  const outcomes = answer.outcomes
    .map(cleanRow)
    .filter((r): r is OutcomeRow => r !== null)
    .filter((r) => !own || own.mine.has(r.content ?? r.campaign ?? ''));
  const regions = answer.regions
    .filter(isObj)
    .map((r) => Object.fromEntries(REGION_FIELDS.map((k) => [k, r[k]])));

  // Re-read the state right before writing, so a cycle's writes in between are kept.
  const fresh = loadFlow(o.repoRoot, home, now);
  const change = fresh ? importMetrics(fresh.cfg, fresh.state, { format: 'json', data: regions }) : undefined;
  if (change?.state) writeJsonAtomic(join(dir(home), 'state.json'), change.state);
  writeJsonAtomic(join(dir(home), 'outcomes.json'), {
    as_of: typeof answer.as_of === 'string' ? answer.as_of : null,
    pulled_at: at,
    since: typeof answer.since === 'string' ? answer.since : null,
    outcomes,
    regions,
  });
  writeJsonAtomic(join(dir(home), 'pull.json'), { ok: true, at } satisfies LastPull);
  return { outcomes: outcomes.length, regions: regions.length };
}

/** What the last good pull wrote, and how the last pull went. */
export function readOutcomes(fwHome: string): Record<string, unknown> {
  const read = (f: string) => {
    const p = join(dir(fwHome), f);
    try {
      return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  return { outcomes: [], regions: [], ...(read('outcomes.json') ?? {}), last_pull: read('pull.json') };
}
