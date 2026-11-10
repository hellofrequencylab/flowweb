// Owner admin for the neighborhood activation flow. The logic is pure (state in, state out); the file
// helpers at the end write $FW_HOME/flows/neighborhood-activation/ atomically. fwd still sends nothing.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FLOW_KEY,
  type FlowConfig,
  type FlowState,
  type Lead,
  type LeadKind,
  type Measures,
  routeLeads,
  type SendVia,
} from './neighborhood-activation.ts';

/** A refusal the route turns into an HTTP error. Nothing has been written when one is thrown. */
export class AdminError extends Error {
  readonly status: 400 | 404 | 409;
  readonly details: Row;
  constructor(status: 400 | 404 | 409, message: string, details: Row = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
export type Skipped = { row: number; reason: string };
type Row = Record<string, unknown>;
/** What an accepted admin action changes. No state and no config means nothing is written or logged. */
export type Change = { state?: FlowState | undefined; config?: Row; summary: string; data: Row };
const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
const KINDS: LeadKind[] = ['host', 'venue', 'builder', 'resident'];
const VIAS: SendVia[] = ['founder_email', 'frequency'];
const MEASURES = ['hosts_active_28d', 'events_next_14d', 'sub_areas_covered_14d', 'wam'] as const;
export const LEAD_COLUMNS = ['name', 'kind', 'territory_id', 'sub_area', 'channel', 'source', 'url'] as const;
const LEAD_HEADER = [...LEAD_COLUMNS, 'fit', 'timing'];
const METRIC_HEADER = ['territory_id', ...MEASURES];

const isObj = (x: unknown): x is Row => typeof x === 'object' && x !== null && !Array.isArray(x);
const text = (v: unknown) => (v === undefined || v === null ? '' : String(v).trim());
const num = (v: unknown) => (text(v) === '' ? Number.NaN : Number(v));
const isUrl = (s: string) => /^https?:\/\/[^\s]+$/i.test(s) && URL.canParse(s);
const isoOr = (v: unknown, fallback: string) => {
  const t = Date.parse(text(v));
  return text(v) === '' ? fallback : Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** The lead id: a stable short hash of its url, so a re-upload finds the same lead. */
export const leadIdOf = (url: string) => `ld_${createHash('sha256').update(url).digest('hex').slice(0, 12)}`;

/** CSV text to rows of fields: quoted fields, "" inside quotes, commas and newlines in quotes, CRLF. */
export function parseCsv(input: string): string[][] {
  const s = input.replace(/^\uFEFF/, '');
  const field = /("(?:[^"]|"")*"|[^",\r\n]*)(,|\r\n|\n|\r|$)/y;
  const rows: string[][] = [];
  let row: string[] = [];
  const end = () => {
    if (row.length > 1 || row[0]) rows.push(row);
    row = [];
  };
  while (field.lastIndex < s.length) {
    const at = field.lastIndex;
    const m = field.exec(s);
    if (!m) throw new AdminError(400, `the CSV has a stray or unclosed quote near character ${at + 1}`);
    const f = m[1] ?? '';
    row.push(f.startsWith('"') ? f.slice(1, -1).replaceAll('""', '"') : f);
    if (m[2] !== ',') end();
  }
  if (row.length) row.push('');
  end();
  return rows;
}

/** An upload body to objects. CSV needs a header with every required column; JSON is an array of objects. */
export function rowsOf(body: Row, required: string[]): Row[] {
  if (body.format === 'json') {
    if (!Array.isArray(body.data))
      throw new AdminError(400, 'data must be an array of objects for format json');
    return body.data.map((r) => (isObj(r) ? r : {}));
  }
  if (body.format !== 'csv') throw new AdminError(400, 'format must be csv or json');
  if (typeof body.data !== 'string') throw new AdminError(400, 'data must be the CSV text for format csv');
  const [head, ...lines] = parseCsv(body.data);
  const cols = (head ?? []).map((h) => h.trim().toLowerCase());
  const absent = required.filter((c) => !cols.includes(c));
  if (absent.length) throw new AdminError(400, `the CSV header is missing ${absent.join(', ')}`, { absent });
  return lines.map((l) => Object.fromEntries(cols.map((c, i) => [c, l[i] ?? ''])));
}

/** Runs `take` on each row; a string it returns is the reason that row (counted from 1) is skipped. */
function eachRow(rows: Row[], take: (r: Row, row: number) => string | undefined): Skipped[] {
  return rows.flatMap((r, i) => {
    const reason = take(r, i + 1);
    return reason ? [{ row: i + 1, reason }] : [];
  });
}

/** Checks one lead row. Returns the lead fields or the reason it is skipped. */
function leadOf(cfg: FlowConfig, r: Row, now: string) {
  const [name = '', kind = '', territory_id = '', sub_area = '', channel = '', source = '', url = ''] =
    LEAD_COLUMNS.map((c) => text(r[c]));
  const t = cfg.territories.find((x) => x.id === territory_id);
  const [fit, timing] = [num(r.fit), num(r.timing)];
  const [timing_at, found_at] = [isoOr(r.timing_at, now), isoOr(r.found_at, now)];
  if (!name) return 'name is empty';
  if (!KINDS.includes(kind as LeadKind)) return `kind "${kind}" is not one of ${KINDS.join(', ')}`;
  if (!t) return `region "${territory_id}" is not in the config`;
  if (sub_area && !t.sub_areas.some((s) => s.id === sub_area)) return `sub-area "${sub_area}" is not there`;
  if (!cfg.sources.some((s) => s.key === source)) return `source "${source}" is not a known lead source`;
  if (!isUrl(url)) return 'url must be an http or https address';
  if (!(fit >= 0 && fit <= 1)) return 'fit must be a number from 0 to 1';
  if (!(timing >= 0 && timing <= 1)) return 'timing must be a number from 0 to 1';
  if (!timing_at || !found_at) return 'timing_at and found_at must be dates when given';
  const lead = { name, kind: kind as LeadKind, territory_id, source, url, fit, timing, timing_at, found_at };
  return { ...lead, ...(sub_area ? { sub_area } : {}), ...(channel ? { channel } : {}) };
}

/** Adds new leads and updates known ones by url (a later row wins). A known lead keeps touches and found_at. */
export function importLeads(cfg: FlowConfig, state: FlowState, body: Row, now: Date): Change {
  const leads = [...state.leads];
  let [added, updated] = [0, 0];
  const skipped = eachRow(rowsOf(body, LEAD_HEADER), (r) => {
    const got = leadOf(cfg, r, now.toISOString());
    if (typeof got === 'string') return got;
    const at = leads.findIndex((l) => l.url === got.url);
    const old = leads[at];
    if (!old) {
      leads.push({ id: leadIdOf(got.url), ...got, touches: [] });
      added++;
      return;
    }
    const { sub_area: _area, channel: _channel, ...rest } = old; // a blank cell clears them
    leads[at] = { ...rest, ...got, found_at: text(r.found_at) ? got.found_at : old.found_at };
    updated++;
  });
  const next = added + updated ? { ...state, leads } : undefined;
  const summary = `Uploaded leads: ${added} added, ${updated} updated, ${skipped.length} skipped.`;
  return { state: next, summary, data: { added, updated, skipped } };
}

/** Sets each region's four measures (and, when given, its weeks at or below the targets). */
export function importMetrics(cfg: FlowConfig, state: FlowState, body: Row): Change {
  const s = { ...state, metrics: { ...state.metrics }, weeks_below: { ...state.weeks_below } };
  s.weeks_at_threshold = { ...state.weeks_at_threshold };
  const seen = new Set<string>();
  const skipped = eachRow(rowsOf(body, METRIC_HEADER), (r) => {
    const id = text(r.territory_id);
    const weeks = (['weeks_at_threshold', 'weeks_below'] as const).filter((k) => text(r[k]) !== '');
    const bad = MEASURES.find((k) => !(num(r[k]) >= 0));
    const badWeek = weeks.find((k) => !Number.isInteger(num(r[k])) || num(r[k]) < 0);
    if (!cfg.territories.some((t) => t.id === id)) return `region "${id}" is not in the config`;
    if (seen.has(id)) return `region "${id}" appears twice in this upload`;
    if (bad) return `${bad} must be a number of 0 or more`;
    if (badWeek) return `${badWeek} must be a whole number of 0 or more`;
    seen.add(id);
    const m = Object.fromEntries(MEASURES.map((k) => [k, num(r[k])])) as unknown as Measures;
    const ch = state.metrics[id]?.channels_by_sub_area;
    s.metrics[id] = ch ? { ...m, channels_by_sub_area: ch } : m;
    for (const k of weeks) s[k][id] = num(r[k]);
  });
  const summary = `Uploaded metrics for ${plural(seen.size, 'region')}, ${skipped.length} skipped.`;
  return { state: seen.size ? s : undefined, summary, data: { updated: seen.size, skipped } };
}

const blocked = (s: FlowState, l: Lead) => [l.id, l.url].some((k) => s.do_not_contact.includes(k));

/** Records a send the Owner made by hand, with its route. */
export function addTouch(state: FlowState, leadId: string, body: Row, now: Date): Change {
  const lead = state.leads.find((l) => l.id === leadId);
  if (!lead) throw new AdminError(404, `lead ${leadId} not found`);
  if (blocked(state, lead)) throw new AdminError(409, `${lead.name} is on the do-not-contact list`);
  if (!VIAS.includes(body.via as SendVia)) throw new AdminError(400, `via must be one of ${VIAS.join(', ')}`);
  const at = isoOr(body.at, now.toISOString());
  if (!at || Date.parse(at) > now.getTime() + 60_000)
    throw new AdminError(400, 'at must be a date, not a future one');
  const touch = { at, via: body.via as SendVia };
  const leads = state.leads.map((l) => (l === lead ? { ...l, touches: [...l.touches, touch] } : l));
  const summary = `Marked ${touch.via === 'frequency' ? 'a Frequency message' : 'a founder email'} sent to ${lead.name}.`;
  return { state: { ...state, leads }, summary, data: { lead_id: lead.id, touch } };
}

/** Puts a lead (by id) or an address (by url) on the do-not-contact list. Doing it twice is harmless. */
export function addDoNotContact(state: FlowState, body: Row): Change {
  const [leadId, url, reason] = [text(body.lead_id), text(body.url), text(body.reason)];
  if (!reason) throw new AdminError(400, 'reason is required');
  if (!leadId === !url) throw new AdminError(400, 'give exactly one of lead_id or url');
  if (url && !isUrl(url)) throw new AdminError(400, 'url must be an http or https address');
  const lead = leadId ? state.leads.find((l) => l.id === leadId) : state.leads.find((l) => l.url === url);
  if (leadId && !lead) throw new AdminError(404, `lead ${leadId} not found`);
  const key = lead?.url ?? url;
  const already = state.do_not_contact.includes(key) || (!!lead && blocked(state, lead));
  const next = already ? undefined : { ...state, do_not_contact: [...state.do_not_contact, key] };
  const summary = `Added ${lead?.name ?? url} to the do-not-contact list: ${reason}`;
  return { state: next, summary, data: { blocked: key, already } };
}

/** Opens a region the flow proposed or the Owner chose. It must be unopened and border an opened one. */
export function openTerritory(cfg: FlowConfig, state: FlowState, id: string): Change {
  const t = cfg.territories.find((x) => x.id === id);
  if (!t) throw new AdminError(404, `region ${id || '(none)'} not found`);
  if (state.opened.includes(id)) throw new AdminError(409, `${t.name} is already open`);
  const touches = (o: string) =>
    t.borders.includes(o) || !!cfg.territories.find((x) => x.id === o)?.borders.includes(id);
  if (!state.opened.some(touches)) throw new AdminError(409, `${t.name} does not border an open region`);
  const opened = [...state.opened, id];
  return { state: { ...state, opened }, summary: `Opened ${t.name}.`, data: { opened } };
}

const ACTIVATION_KEYS = 'hosts_floor hosts_per_10k events_per_host_14d sub_area_share channels_per_sub_area'
  .concat(' wam_per_host hold_weeks upkeep_relapse_weeks')
  .split(' ');

/** Every reason a whole config would break the flow. Empty means it is safe to save. */
export function validateConfig(raw: unknown, opened: string[] = []): string[] {
  if (!isObj(raw)) return ['the config must be a JSON object'];
  const errs: string[] = [];
  const need = (ok: unknown, why: string) => ok || errs.push(why);
  const ts = Array.isArray(raw.territories) ? raw.territories : [];
  const ids = ts.map((t) => (isObj(t) ? text(t.id) : ''));
  need(ts.length, 'territories must be a non-empty list');
  for (const [i, t] of ts.entries()) {
    const id = ids[i] || `#${i + 1}`;
    if (!isObj(t) || !ids[i] || !text(t.name)) {
      errs.push(`region ${id} needs an id and a name`);
      continue;
    }
    const subs = Array.isArray(t.sub_areas) ? t.sub_areas : [];
    need(ids.indexOf(id) === i, `region ${id} appears twice`);
    need(typeof t.order === 'number', `region ${id} needs a number order`);
    need(subs.length >= 2, `region ${id} needs at least 2 sub-areas`);
    const subOk = subs.every((s) => isObj(s) && text(s.id) && text(s.name) && num(s.population) >= 0);
    need(subOk, `every sub-area of ${id} needs an id, a name and a population of 0 or more`);
    need(Array.isArray(t.borders), `region ${id} needs a borders list`);
    for (const b of Array.isArray(t.borders) ? t.borders.map(text) : [])
      need(ids.includes(b) && b !== id, `region ${id} borders "${b}", which is not another region`);
  }
  need(ids.includes(text(raw.seed_territory_id)), 'seed_territory_id must name a region');
  for (const o of opened) need(ids.includes(o), `region ${o} is open, so it cannot be removed`);
  const [a, f] = [raw.activation, raw.funnels].map((x) => (isObj(x) ? x : {})) as [Row, Row];
  for (const k of ACTIVATION_KEYS) need(num(a[k]) > 0, `activation.${k} must be a positive number`);
  for (const k of KINDS) {
    const fk = isObj(f[k]) ? f[k] : {};
    need(text(fk.path) && text(fk.persona), `funnels.${k} needs a path and a persona`);
  }
  const { offer, leads, send_routes, sources, engine, max_active_sub_areas: most } = raw;
  const kept = [leads, send_routes, engine].every(isObj) && Array.isArray(sources) && num(most) >= 0;
  const why = 'offer.url, leads, send_routes, sources, engine and max_active_sub_areas must stay';
  need(kept && isObj(offer) && isUrl(text(offer.url)), why);
  return errs;
}

/** Saves a whole config once it validates; the summary names the activation numbers that changed. */
export function saveConfig(cfg: FlowConfig, state: FlowState, body: Row): Change {
  const errors = validateConfig(body, state.opened);
  if (errors.length) throw new AdminError(400, 'the config is not valid', { errors });
  const [was, now] = [cfg.activation as unknown as Row, body.activation as Row];
  const what = ACTIVATION_KEYS.filter((k) => was[k] !== now[k]).map((k) => `; ${k} ${was[k]} to ${now[k]}`);
  const summary = `Saved the config (${plural((body.territories as []).length, 'region')}${what.join('')}).`;
  return { config: body, summary, data: { saved: true } };
}

const CSV_COLS = LEAD_HEADER.concat('timing_at found_at id stage send_via touches last_touch_at'.split(' '));

/** One CSV field: quoted when needed, and a leading = + - @ neutralised so a spreadsheet shows text. */
export function csvField(v: unknown): string {
  let s = text(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** Leads as CSV: the upload columns first, so the file can be edited and uploaded again. */
export function leadsCsv(cfg: FlowConfig, state: FlowState, now: Date): string {
  const lines = routeLeads(cfg, state, now).map(({ lead: l, stage, send_via }) => {
    const r: Row = { ...l, stage, send_via, touches: l.touches.length, last_touch_at: l.touches.at(-1)?.at };
    return CSV_COLS.map((c) => csvField(r[c])).join(',');
  });
  return `${[CSV_COLS.join(','), ...lines].join('\r\n')}\r\n`;
}

// ---- files ----------------------------------------------------------------------------------------

export type AdminAction = 'leads' | 'metrics' | 'touch' | 'do_not_contact' | 'open' | 'config';
export type AdminLogEntry = { at: string; action: AdminAction; summary: string };
export const adminDir = (fwHome: string) => join(fwHome, 'flows', FLOW_KEY);

/** Writes a JSON file through a temp file and a rename, so a reader never sees half of it. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export function appendAdminLog(fwHome: string, entry: AdminLogEntry): void {
  mkdirSync(adminDir(fwHome), { recursive: true });
  appendFileSync(join(adminDir(fwHome), 'admin-log.jsonl'), `${JSON.stringify(entry)}\n`);
}

/** The newest entries first. A line that is not a log entry (a torn last line, say) is left out. */
export function readAdminLog(fwHome: string, limit = 50): AdminLogEntry[] {
  const p = join(adminDir(fwHome), 'admin-log.jsonl');
  const lines = existsSync(p) ? readFileSync(p, 'utf8').split('\n').reverse() : [];
  return lines.flatMap(logEntry).slice(0, limit);
}

function logEntry(line: string): AdminLogEntry[] {
  try {
    const e = JSON.parse(line) as unknown;
    return isObj(e) && typeof e.at === 'string' && typeof e.action === 'string' ? [e as AdminLogEntry] : [];
  } catch {
    return [];
  }
}
