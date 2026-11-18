// FW-C-154: a draft never points at an event that has passed. Two places use this: the hunt screen
// leaves out a lead whose event is over, and each cycle (and fwd's start) retires waiting hunt drafts
// whose event is over, so the Owner never sends about something that already happened. A retired
// draft frees its contact, so a later hunt may draft again for the same organizer's next event.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DAY = 86_400_000;
/** A date with no time, or one in another zone, still counts as upcoming until a day after it. */
export const PASSED_GRACE_MS = DAY;
/** A waiting hunt draft with no event date is retired once it is this old: nobody can tell it is current. */
export const UNDATED_MAX_AGE_MS = 7 * DAY;

type Doc = Record<string, unknown>;
const isObj = (x: unknown): x is Doc => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** True when starts_at is a readable date more than a day behind now. An unreadable date is not passed. */
export function eventPassed(startsAt: unknown, now: Date): boolean {
  const t = Date.parse(str(startsAt) ?? '');
  return Number.isFinite(t) && now.getTime() - t > PASSED_GRACE_MS;
}

/** Why a waiting hunt draft is no longer current, or null when it is. */
export function staleReason(doc: Doc, now: Date): 'event_passed' | 'no_event_date' | null {
  if (doc.status !== 'waiting_for_owner' || !str(doc.hunt_id)) return null;
  if (str(doc.sent_at) || str(doc.replied_at) || str(doc.declined_at)) return null;
  const starts = isObj(doc.event) ? str(doc.event.starts_at) : null;
  if (eventPassed(starts, now)) return 'event_passed';
  if (starts && Number.isFinite(Date.parse(starts))) return null;
  const made = Date.parse(str(doc.created_at) ?? '');
  return Number.isFinite(made) && now.getTime() - made > UNDATED_MAX_AGE_MS ? 'no_event_date' : null;
}

const WORDS = {
  event_passed: 'The event this note was written about has passed.',
  no_event_date: 'This note is over a week old and its event has no date, so it may have passed.',
} as const;

function save(path: string, doc: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Retires the flow's waiting hunt drafts that are no longer current (home is the flow's own home: a
 * copy's home for a copy). The draft stays on disk as rejected with retired and held saying why, and
 * its contact leaves state.json's hunt_contacts. Returns the ids it retired. Never throws.
 */
export function retirePastDrafts(o: {
  home: string;
  flow: string;
  now?: Date;
  log?: ((m: string) => void) | undefined;
}): string[] {
  const now = o.now ?? new Date();
  const base = join(o.home, 'flows', o.flow);
  const dir = join(base, 'drafts');
  const retired: string[] = [];
  const freed = new Set<string>();
  try {
    if (!existsSync(dir)) return retired;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const path = join(dir, f);
        const doc = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        if (!isObj(doc) || typeof doc.id !== 'string') continue;
        const why = staleReason(doc, now);
        if (!why) continue;
        const at = now.toISOString();
        save(path, {
          ...doc,
          status: 'rejected',
          rejected_at: at,
          retired: why,
          held: `${why}: ${WORDS[why]}`,
        });
        retired.push(doc.id);
        for (const k of [str(doc.to), str(doc.contact_url)]) if (k) freed.add(k.toLowerCase());
      } catch {
        // A file being written or not a draft: skip it.
      }
    }
    const sp = join(base, 'state.json');
    if (freed.size > 0 && existsSync(sp)) {
      const state = JSON.parse(readFileSync(sp, 'utf8')) as unknown;
      if (isObj(state) && isObj(state.hunt_contacts)) {
        const kept = Object.fromEntries(
          Object.entries(state.hunt_contacts).filter(([k]) => !freed.has(k.toLowerCase())),
        );
        save(sp, { ...state, hunt_contacts: kept });
      }
    }
    if (retired.length > 0)
      o.log?.(`drafts: ${o.flow}: retired ${retired.length} waiting draft(s) whose event has passed`);
  } catch (e) {
    o.log?.(`drafts: ${o.flow}: could not retire past drafts: ${(e as Error)?.message ?? e}`);
  }
  return retired;
}
