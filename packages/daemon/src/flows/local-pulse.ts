// FW-C-107: the local pulse flow's data. fwd asks Frequency for the next 14 days of public events
// (GET /api/webhooks/flowweb-upcoming, signed like the outcomes pull) and keeps the ones in the open
// sub-areas. A failed pull keeps the last good upcoming.json and records why. It also keeps the venue QR
// poster list (venues.json).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Reader } from '@fw/eventlog';
import { ApiError, envelope, readJsonBody } from '../api/http.ts';
import type { Router } from '../api/router.ts';
import { CredentialError, resolveCredential } from '../creds/index.ts';
import { writeJsonAtomic } from './neighborhood-admin.ts';
import { OUTCOMES_HANDLE, sign } from './outcomes.ts';

export const FLOW_KEY = 'local-pulse';
const PATH = '/api/webhooks/flowweb-upcoming';
export const DAY = 86_400_000;

export interface SubArea {
  id: string;
  name: string;
  towns: string[];
}
export interface Group {
  name: string;
  url: string;
  allows_promo: boolean;
  last_posted_at: string | null;
}
export interface Venue {
  venue: string;
  source_tag: string;
  poster_dropped_at: string | null;
}
export interface PulseConfig {
  offer: { url: string };
  window_days?: number;
  group_cooldown_days?: number;
  open_sub_areas: SubArea[];
  groups: Group[];
  venues: Venue[];
}
export interface UpcomingEvent {
  event_id: string;
  title: string;
  starts_at: string;
  town: string;
  niche: string | null;
  rsvp_url: string;
  host_id?: string;
  first_name?: string;
}
export type LastPull = { ok: boolean; at: string; error?: string; events?: number };
export type GroupStatus = { name: string; url: string; status: 'drafted' | 'posted_recently' | 'no_promo' };

export const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
export const dir = (fwHome: string) => join(fwHome, 'flows', FLOW_KEY);
export const readJson = (p: string): unknown => {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  } catch {
    return null;
  }
};
export const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'x';

/** The config this machine uses: the Owner's copy in $FW_HOME wins over the repo's. Null when not shipped. */
export function loadConfig(repoRoot: string, fwHome: string): PulseConfig | null {
  const repo = join(repoRoot, 'flows', FLOW_KEY);
  if (!existsSync(join(repo, 'stream.json'))) return null;
  const raw = (readJson(join(dir(fwHome), 'config.json')) ??
    readJson(join(repo, 'config.json'))) as Partial<PulseConfig> | null;
  return {
    offer: { url: str(raw?.offer?.url) ?? 'https://frequencylocal.com' },
    window_days: Number(raw?.window_days) || 14,
    group_cooldown_days: Number(raw?.group_cooldown_days) || 7,
    open_sub_areas: Array.isArray(raw?.open_sub_areas) ? raw.open_sub_areas : [],
    groups: Array.isArray(raw?.groups) ? raw.groups : [],
    venues: Array.isArray(raw?.venues) ? raw.venues : [],
  };
}

/** Keeps the contract fields of one event (frequency-web flowweb-upcoming); anything else is dropped. */
export function cleanEvent(raw: unknown): UpcomingEvent | null {
  if (!isObj(raw)) return null;
  const [event_id, title, starts_at, town, rsvp_url] = [
    'event_id',
    'title',
    'starts_at',
    'town',
    'rsvp_url',
  ].map((k) => str(raw[k]));
  if (!event_id || !title || !starts_at || !town || !rsvp_url || !Number.isFinite(Date.parse(starts_at)))
    return null;
  if (!/^https?:\/\//.test(rsvp_url)) return null;
  const host = str(raw.host_id);
  const first = str(raw.first_name);
  return {
    event_id,
    title,
    starts_at,
    town,
    niche: str(raw.niche),
    rsvp_url,
    ...(host ? { host_id: host } : {}),
    ...(first ? { first_name: first } : {}),
  };
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** The open sub-area an event's town belongs to, or null. */
export function subAreaOf(cfg: PulseConfig, town: string): SubArea | null {
  const t = norm(town);
  return (
    cfg.open_sub_areas.find(
      (a) => norm(a.id.replace(/-/g, ' ')) === t || [a.name, ...(a.towns ?? [])].some((x) => norm(x) === t),
    ) ?? null
  );
}

/** Events in the open sub-areas that start between now and the window's end, soonest first. */
export function inArea(cfg: PulseConfig, events: UpcomingEvent[], now: Date): UpcomingEvent[] {
  const from = now.getTime();
  const to = from + (cfg.window_days ?? 14) * DAY;
  const seen = new Set<string>();
  return events
    .filter((e) => {
      const t = Date.parse(e.starts_at);
      if (!(t >= from && t <= to) || !subAreaOf(cfg, e.town) || seen.has(e.event_id)) return false;
      seen.add(e.event_id);
      return true;
    })
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
}

export function readUpcoming(fwHome: string): {
  as_of: string | null;
  pulled_at: string | null;
  events: UpcomingEvent[];
} {
  const raw = readJson(join(dir(fwHome), 'upcoming.json'));
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.events) ? raw.events : [];
  return {
    as_of: isObj(raw) ? str(raw.as_of) : null,
    pulled_at: isObj(raw) ? str(raw.pulled_at) : null,
    events: list.map(cleanEvent).filter((e): e is UpcomingEvent => e !== null),
  };
}

/** Asks Frequency for upcoming events. A good answer replaces upcoming.json; a failure keeps it. */
export async function pullUpcoming(o: {
  cfg: PulseConfig;
  fwHome: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}): Promise<LastPull> {
  const now = o.now ?? new Date();
  const at = now.toISOString();
  const record = (p: LastPull) => {
    writeJsonAtomic(join(dir(o.fwHome), 'pull.json'), p);
    return p;
  };
  let secret: string;
  try {
    secret = resolveCredential(OUTCOMES_HANDLE, { home: o.fwHome });
  } catch (e) {
    const why = e instanceof CredentialError ? e.message : String(e);
    return record({ ok: false, at, error: `no secret for ${OUTCOMES_HANDLE}: ${why}` });
  }
  const site = (o.env?.FW_FREQUENCY_URL || o.cfg.offer.url).replace(/\/$/, '');
  const q = new URLSearchParams({
    sub_areas: o.cfg.open_sub_areas.map((a) => a.id).join(','),
    days: String(o.cfg.window_days ?? 14),
  });
  const ts = String(Math.floor(now.getTime() / 1000));
  let answer: unknown;
  try {
    const res = await fetch(`${site}${PATH}?${q}`, {
      method: 'GET',
      headers: { 'x-flowweb-timestamp': ts, 'x-flowweb-signature': sign(secret, ts, '') },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return record({ ok: false, at, error: `Frequency answered ${res.status}` });
    answer = await res.json();
  } catch (e) {
    return record({ ok: false, at, error: `could not reach Frequency: ${(e as Error)?.message ?? e}` });
  }
  const list = Array.isArray(answer)
    ? answer
    : isObj(answer) && Array.isArray(answer.events)
      ? answer.events
      : null;
  if (!list) return record({ ok: false, at, error: 'Frequency answered without events' });
  const events = list.map(cleanEvent).filter((e): e is UpcomingEvent => e !== null);
  writeJsonAtomic(join(dir(o.fwHome), 'upcoming.json'), {
    as_of: isObj(answer) ? str(answer.as_of) : null,
    pulled_at: at,
    events,
  });
  return record({ ok: true, at, events: events.length });
}

/** The poster list with scans per source_tag from the outcomes pull, when it carries qr counts. */
export function readVenues(repoRoot: string, fwHome: string): (Venue & { scans_7d: number | null })[] {
  const saved = readJson(join(dir(fwHome), 'venues.json'));
  const list =
    (isObj(saved) && Array.isArray(saved.venues) ? saved.venues : loadConfig(repoRoot, fwHome)?.venues) ?? [];
  const outcomes = readJson(join(fwHome, 'flows', 'neighborhood-activation', 'outcomes.json'));
  const qr = isObj(outcomes) && Array.isArray(outcomes.qr) ? outcomes.qr.filter(isObj) : [];
  return list.filter(isObj).flatMap((v) => {
    const tag = str(v.source_tag);
    const venue = str(v.venue);
    if (!tag || !venue) return [];
    const n = qr.find((q) => q.source_tag === tag)?.scans_7d;
    return [
      {
        venue,
        source_tag: tag,
        poster_dropped_at: str(v.poster_dropped_at),
        scans_7d: typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null,
      },
    ];
  });
}

/** Marks a venue's poster dropped (now, or body.at). An unknown tag with a venue name adds the venue. */
export function markDropped(repoRoot: string, fwHome: string, tag: string, body: Record<string, unknown>) {
  const at = str(body.at) ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(at))) throw new ApiError(400, 'validation_failed', 'at must be a date');
  const venues = readVenues(repoRoot, fwHome).map(({ scans_7d: _s, ...v }) => v);
  const hit = venues.find((v) => v.source_tag === tag);
  if (hit) hit.poster_dropped_at = at;
  else if (str(body.venue) && /^[a-z0-9_-]{1,60}$/i.test(tag))
    venues.push({ venue: str(body.venue) as string, source_tag: tag, poster_dropped_at: at });
  else throw new ApiError(404, 'not_found', `no venue with source_tag ${tag}; give a venue name to add it`);
  writeJsonAtomic(join(dir(fwHome), 'venues.json'), { venues });
  return readVenues(repoRoot, fwHome);
}

/** GET /v1/flows/local-pulse. */
export function flowView(repoRoot: string, fwHome: string, now: Date) {
  const cfg = loadConfig(repoRoot, fwHome);
  if (!cfg) return null;
  const up = readUpcoming(fwHome);
  return {
    key: FLOW_KEY,
    open_sub_areas: cfg.open_sub_areas,
    upcoming: { as_of: up.as_of, pulled_at: up.pulled_at, events: inArea(cfg, up.events, now) },
    last_pull: readJson(join(dir(fwHome), 'pull.json')),
    last_run: readJson(join(dir(fwHome), 'run.json')),
    groups: cfg.groups,
    venues: readVenues(repoRoot, fwHome),
  };
}

/** The Supervisor's facts: the stream's caps, no model spend, and no channel that reaches the outbox. */
export function engineFacts(repoRoot: string, fwHome: string) {
  if (!loadConfig(repoRoot, fwHome)) return null;
  const s = readJson(join(repoRoot, 'flows', FLOW_KEY, 'stream.json')) as {
    budget?: { period?: string; caps?: { max_usd?: number; max_turns?: number } };
  } | null;
  const c = s?.budget?.caps ?? {};
  return {
    caps: { period: s?.budget?.period ?? 'week', max_usd: c.max_usd ?? null, max_turns: c.max_turns ?? null },
    spend: { usd: 0, turns: 0 },
    outward: [],
  };
}

export function addLocalPulseRoutes(
  r: Router,
  deps: { reader: Reader; repoRoot: string; fwHome: string },
): void {
  const base = `/v1/flows/${FLOW_KEY}`;
  r.get(`${base}/venues`, () =>
    envelope(deps.reader, () => ({ data: readVenues(deps.repoRoot, deps.fwHome) })),
  );
  r.post(`${base}/venues/{tag}/dropped`, async ({ req, params }) => {
    const body = await readJsonBody(req);
    const data = markDropped(deps.repoRoot, deps.fwHome, params.tag ?? '', body);
    return envelope(deps.reader, () => ({ data }));
  });
}
