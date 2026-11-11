// FW-C-102: the facts sheet. The only prices and dates a draft may quote live in $FW_HOME/facts.json
// ({beta_ends, prices{...}, launcher_minutes, fetched_at}). When the outcomes secret is set, fwd refreshes
// it once a day from Frequency (GET /api/webhooks/flowweb-facts, signed like every webhook: hex HMAC-SHA256
// of `${timestamp}.${body}`, the body empty for a GET). A failed refresh keeps the last good file and
// records why in facts-pull.json, so an outage never wipes the facts the gate checks against.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CredentialError, resolveCredential } from '../creds/index.ts';
import { writeJsonAtomic } from './neighborhood-admin.ts';
import { OUTCOMES_HANDLE, sign } from './outcomes.ts';

export const FACTS_PATH = '/api/webhooks/flowweb-facts';
const DAY = 86_400_000;

export interface Facts {
  beta_ends: string | null;
  prices: Record<string, number | string>;
  launcher_minutes: number | null;
  fetched_at: string | null;
}
export type FactsPull = { ok: boolean; at: string; error?: string };

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const file = (fwHome: string, f: string) => join(fwHome, f);

/** The facts in the sheet's shape, or null when it is not one (unknown fields are dropped). */
export function cleanFacts(raw: unknown, fetchedAt: string | null): Facts | null {
  if (!isObj(raw) || !isObj(raw.prices)) return null;
  const prices: Facts['prices'] = {};
  for (const [k, v] of Object.entries(raw.prices))
    if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string') prices[k] = v;
  const minutes = raw.launcher_minutes;
  return {
    beta_ends: typeof raw.beta_ends === 'string' ? raw.beta_ends : null,
    prices,
    launcher_minutes: typeof minutes === 'number' && Number.isFinite(minutes) ? minutes : null,
    fetched_at: fetchedAt ?? (typeof raw.fetched_at === 'string' ? raw.fetched_at : null),
  };
}

/** The last good facts sheet, or null when there is none. */
export function readFacts(fwHome: string): Facts | null {
  try {
    return cleanFacts(JSON.parse(readFileSync(file(fwHome, 'facts.json'), 'utf8')), null);
  } catch {
    return null;
  }
}

/** How the last refresh went, or null when none has run. */
export function lastFactsPull(fwHome: string): FactsPull | null {
  try {
    return JSON.parse(readFileSync(file(fwHome, 'facts-pull.json'), 'utf8')) as FactsPull;
  } catch {
    return null;
  }
}

/**
 * Asks Frequency for the facts sheet and writes it. Without the outcomes secret nothing runs (skipped).
 * Any failure keeps facts.json as it was and records the reason.
 */
export async function refreshFacts(o: {
  fwHome: string;
  site: string;
  now?: Date;
}): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const now = o.now ?? new Date();
  let secret: string;
  try {
    secret = resolveCredential(OUTCOMES_HANDLE, { home: o.fwHome });
  } catch (e) {
    if (e instanceof CredentialError) return { ok: false, skipped: true, error: 'no secret' };
    throw e;
  }
  const at = now.toISOString();
  const fail = (error: string) => {
    writeJsonAtomic(file(o.fwHome, 'facts-pull.json'), { ok: false, at, error } satisfies FactsPull);
    return { ok: false, error };
  };
  const ts = String(Math.floor(now.getTime() / 1000));
  let answer: unknown;
  try {
    const res = await fetch(`${o.site.replace(/\/$/, '')}${FACTS_PATH}`, {
      method: 'GET',
      headers: { 'x-flowweb-timestamp': ts, 'x-flowweb-signature': sign(secret, ts, '') },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return fail(`Frequency answered ${res.status}`);
    answer = await res.json();
  } catch (e) {
    return fail(`could not reach Frequency: ${(e as Error)?.message ?? e}`);
  }
  const facts = cleanFacts(answer, at);
  if (!facts) return fail('Frequency answered without a facts sheet');
  writeJsonAtomic(file(o.fwHome, 'facts.json'), facts);
  writeJsonAtomic(file(o.fwHome, 'facts-pull.json'), { ok: true, at } satisfies FactsPull);
  return { ok: true };
}

/** Refreshes when the last attempt is a day old or there was none; otherwise does nothing. Never throws. */
export async function refreshFactsIfDue(o: { fwHome: string; site: string; now?: Date }): Promise<void> {
  const now = o.now ?? new Date();
  const last = lastFactsPull(o.fwHome);
  const t = last ? Date.parse(last.at) : Number.NaN;
  if (Number.isFinite(t) && now.getTime() - t < DAY && existsSync(file(o.fwHome, 'facts.json'))) return;
  await refreshFacts({ ...o, now }).catch(() => undefined);
}
