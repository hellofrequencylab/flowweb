// FW-C-109: event intake. The Owner pastes event listings or a forwarded email body, or names one city or
// library iCal or RSS address, and fwd extracts each event, dedupes it on normalized title, date and venue,
// and queues it in $FW_HOME/flows/<flow>/intake/queue.json with status needs_check. Extraction is
// deterministic first (iCal, RSS, a line pattern for pasted text); the flow's engine is asked only when
// that finds nothing (overseer/intake-engine.ts). Inbound text is data, never instructions: no field of it
// changes what fwd does. Social sites are never fetched and ticketing sites are not crawled. Nothing here
// publishes, posts or sends: the queue waits for the Owner, who acts on it by hand.
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type LeadNode, leadsPath, loadGraph, nodesFor, refreshLeads } from './leads.ts';
import { writeJsonAtomic } from './neighborhood-admin.ts';

export type IntakeStatus = 'needs_check' | 'approved' | 'rejected';
export type IntakeSource = 'paste' | 'ical' | 'rss' | 'engine';
/** One extracted event before it is queued. Every field is inbound data. */
export type Extracted = {
  title: string;
  starts_at: string | null;
  town: string | null;
  venue: string | null;
  niche: string | null;
  host_name: string | null;
  source_url: string | null;
  contact: string | null;
};
export type IntakeEvent = Extracted & {
  id: string;
  source: IntakeSource;
  status: IntakeStatus;
  created_at: string;
  checked_at: string | null;
};

export class IntakeError extends Error {
  readonly status: 400 | 404 | 502;
  constructor(status: 400 | 404 | 502, message: string) {
    super(message);
    this.status = status;
  }
}

export const MAX_TEXT = 100_000;
const MAX_QUEUE = 2_000;
const MAX_FETCH_BYTES = 2_000_000;
const TZ = 'America/Los_Angeles';

/** Hosts fwd never fetches: social sites (never), ticketing sites (not crawled). */
const BLOCKED = ['instagram.com', 'instagr.am', 'facebook.com', 'fb.com', 'fb.me', 'meetup.com'];
/** Why fwd will not fetch this address, or null when one fetch is allowed. */
export function refusedUrl(raw: string): string | null {
  if (!URL.canParse(raw)) return 'not a web address';
  const u = new URL(raw);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'only http and https addresses';
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED.some((d) => host === d || host.endsWith(`.${d}`)) || /(^|\.)eventbrite\.[a-z.]+$/.test(host))
    return `${host} is never fetched; paste the listing text instead`;
  return null;
}

/** Every address a host name resolves to. */
export type Lookup = (host: string) => Promise<string[]>;
const systemLookup: Lookup = async (h) =>
  (await dnsLookup(h, { all: true, verbatim: true })).map((a) => a.address);
/** fwd's own default port: a calendar fetch never reaches the daemon itself. */
const FWD_PORT = '7317';

const v4 = (ip: string): number[] | null => {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null;
};

/**
 * What kind of address fwd must not fetch from (FW-C-115): private, link-local, unique-local, carrier
 * NAT, unspecified, multicast or broadcast, and loopback unless allowed. Null for a public address.
 */
export function privateAddress(raw: string, allowLoopback = false): string | null {
  let ip = raw
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '');
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(.+)$/.exec(ip)?.[1];
  if (mapped) {
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
    ip = hex
      ? [parseInt(hex[1] as string, 16), parseInt(hex[2] as string, 16)]
          .flatMap((n) => [n >> 8, n & 255])
          .join('.')
      : mapped;
  }
  const a = v4(ip);
  if (a) {
    const [x = 0, y = 0] = a;
    if (x === 127) return allowLoopback ? null : 'loopback';
    if (x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168)) return 'private';
    if (x === 169 && y === 254) return 'link-local';
    if (x === 100 && y >= 64 && y <= 127) return 'carrier NAT';
    if (x === 0 || x >= 224) return 'unspecified, multicast or broadcast';
    return null;
  }
  if (!ip.includes(':')) return null;
  if (/^[0:]+1$/.test(ip)) return allowLoopback ? null : 'loopback';
  if (/^[0:]+$/.test(ip)) return 'unspecified';
  if (/^fe[89ab][0-9a-f]?:/.test(ip)) return 'link-local';
  if (/^f[cd][0-9a-f]{0,2}:/.test(ip)) return 'unique-local';
  if (/^ff[0-9a-f]{0,2}:/.test(ip)) return 'multicast';
  return null;
}

/** Reads at most cap bytes of a body, stopping the stream there. */
async function readCapped(res: Response, cap: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, cap);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  while (n < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, cap));
}

/** A link worth keeping: http or https only, so a javascript: or data: link never reaches the page. */
const webUrl = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) && URL.canParse(u) ? u : null);
const clip = (s: string | null | undefined, n = 200) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, n) : null;
};
const pad = (n: number | string) => String(n).padStart(2, '0');
const norm = (s: string | null) =>
  (s ?? '')
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.join(' ') ?? '';
export const dedupeKey = (e: Extracted) =>
  `${norm(e.title)}|${(e.starts_at ?? '').slice(0, 10)}|${norm(e.venue)}`;

const NICHES: [RegExp, string][] = [
  [/sound (bath|healing|journey)/i, 'sound-healing'],
  [/breathwork/i, 'breathwork'],
  [/ecstatic|conscious dance/i, 'ecstatic-dance'],
  [/yoga/i, 'yoga'],
  [/dance|movement/i, 'dance'],
  [/open mic|poetry|improv/i, 'expression'],
  [/drum|jam\b|music|choir|sing/i, 'music'],
  [/swap/i, 'swaps'],
  [/maker|hacker|solder|repair/i, 'makers'],
  [/\bart\b|open studio|paint|draw/i, 'art'],
  [/workshop|circle|retreat/i, 'personal-growth'],
];
const nicheOf = (...parts: (string | null)[]) => NICHES.find(([re]) => re.test(parts.join(' ')))?.[1] ?? null;

// ---- pasted text and forwarded email --------------------------------------------------------------

const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');
const DAY_NAME = '(?:(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day)?\\.?,?\\s+)?';
const ISO = /\b(20\d\d)-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d))?/;
const NAMED = new RegExp(
  `${DAY_NAME}\\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d\\d))?\\b`,
  'i',
);
const NUMERIC = new RegExp(`${DAY_NAME}\\b(\\d{1,2})/(\\d{1,2})(?:/(20\\d\\d|\\d\\d))?\\b`, 'i');
const CLOCK = /\b(\d{1,2})(?::(\d\d))?\s*(am|pm)\b|\b([01]?\d|2[0-3]):([0-5]\d)\b/i;
const URL_RE = /https?:\/\/[^\s,;<>()\]"']+/i;
const EMAIL_RE = /[^\s@<>(),;:"']+@[^\s@<>(),;:"']+\.[a-z]{2,}/i;
const HOST_RE = /\b(?:hosted by|host:|led by|organi[sz]ed by|organi[sz]er:)\s*([^,|;\n]+)/i;
const HEADER =
  /^\s*(from|to|cc|bcc|date|sent|subject|reply-to):|^\s*-+\s*forwarded message|^\s*begin forwarded/i;

/** A month and day without a year means the next one on or after today. */
function dateOf(y: number | null, m: number, d: number, now: Date): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  let year = y ?? now.getFullYear();
  if (y === null && new Date(year, m - 1, d + 1) < now) year += 1;
  return `${year}-${pad(m)}-${pad(d)}`;
}

/** Finds a date (and a time) in a line, and answers it with the line minus those words. */
function findWhen(line: string, now: Date): { at: string; rest: string } | null {
  let date: string | null = null;
  let rest = line;
  const iso = ISO.exec(rest);
  const named = NAMED.exec(rest);
  const num = NUMERIC.exec(rest);
  if (iso) {
    date = dateOf(Number(iso[1]), Number(iso[2]), Number(iso[3]), now);
    if (date && iso[4]) date += `T${iso[4]}:${iso[5]}`;
    rest = rest.replace(iso[0], ',');
  } else if (named) {
    const m = MONTHS.indexOf((named[1] as string).toLowerCase().slice(0, 3)) + 1;
    date = dateOf(named[3] ? Number(named[3]) : null, m, Number(named[2]), now);
    rest = rest.replace(named[0], ',');
  } else if (num) {
    const y = num[3] ? Number(num[3].length === 2 ? `20${num[3]}` : num[3]) : null;
    date = dateOf(y, Number(num[1]), Number(num[2]), now);
    rest = rest.replace(num[0], ',');
  }
  if (!date) return null;
  const c = date.includes('T') ? null : CLOCK.exec(rest);
  if (c) {
    let h = Number(c[1] ?? c[4]);
    const min = c[2] ?? c[5] ?? '00';
    const ap = c[3]?.toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h < 24) date += `T${pad(h)}:${min}`;
    rest = rest.replace(c[0], ',');
  }
  return { at: date, rest };
}

/** One event per line that carries a date. A line without a date is not an event. */
export function parsePaste(text: string, now: Date): Extracted[] {
  const out: Extracted[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line0 = raw.replace(/^\s*(>\s*)+/, '').trim();
    if (!line0 || HEADER.test(line0) || line0.length > 1_000) continue;
    // Links and addresses come out first, so a date inside a link is not the event's date.
    const url = URL_RE.exec(line0)?.[0]?.replace(/[.]+$/, '') ?? null;
    let line = url ? line0.replace(url, ',') : line0;
    const email = EMAIL_RE.exec(line)?.[0] ?? null;
    if (email) line = line.replace(email, ',');
    const when = findWhen(line, now);
    if (!when) continue;
    let rest = when.rest;
    const hostM = HOST_RE.exec(rest);
    if (hostM) rest = rest.replace(hostM[0], ',');
    const chunks = rest
      .split(/\s*(?:[|;,]|\s[-\u2013\u2014]\s)\s*/)
      .map((c) => c.replace(/^[\s.:-]+|[\s.:-]+$/g, ''))
      .filter((c) => /[a-z]/i.test(c));
    const head = chunks.shift();
    if (!head) continue;
    const [title, atVenue] = head.split(/\s+(?:at|@)\s+/i, 2);
    const venue = atVenue ?? chunks.shift() ?? null;
    const townChunk = chunks.find((c) => c.length <= 40 && !/\d/.test(c)) ?? null;
    out.push({
      title: clip(title) ?? '',
      starts_at: when.at,
      venue: clip(venue),
      town: clip(townChunk, 80),
      niche: nicheOf(title ?? '', venue),
      host_name: clip(hostM?.[1], 120),
      source_url: url,
      contact: email,
    });
  }
  return out.filter((e) => e.title !== '');
}

// ---- iCal and RSS ---------------------------------------------------------------------------------

const icsText = (v: string) => v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');

/** Wall time in the flow's zone for a UTC instant. */
function localOf(d: Date): string {
  // sv-SE writes YYYY-MM-DD HH:MM:SS, so the wall time reads straight off it.
  return d.toLocaleString('sv-SE', { timeZone: TZ, hourCycle: 'h23' }).replace(' ', 'T').slice(0, 16);
}

function icalTime(v: string): string | null {
  const m = /^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)?(Z)?)?$/.exec(v.trim());
  if (!m) return null;
  if (!m[4]) return `${m[1]}-${m[2]}-${m[3]}`;
  if (m[7]) return localOf(new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4], +m[5]!)));
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
}

/** Splits "NAME;P=a;Q=\"b:c\":value" at the first colon outside quotes. */
function prop(line: string): { name: string; params: string; value: string } {
  let q = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') q = !q;
    else if (line[i] === ':' && !q) {
      const head = line.slice(0, i);
      const semi = head.indexOf(';');
      return {
        name: (semi < 0 ? head : head.slice(0, semi)).toUpperCase(),
        params: semi < 0 ? '' : head.slice(semi + 1),
        value: line.slice(i + 1),
      };
    }
  }
  return { name: '', params: '', value: '' };
}

export function parseIcal(text: string, calendarUrl: string | null): Extracted[] {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const out: Extracted[] = [];
  let cur: Record<string, { params: string; value: string }> | null = null;
  for (const line of lines) {
    if (/^BEGIN:VEVENT/i.test(line)) cur = {};
    else if (/^END:VEVENT/i.test(line) && cur) {
      const title = clip(icsText(cur.SUMMARY?.value ?? ''));
      const venue = clip(icsText(cur.LOCATION?.value ?? ''));
      const parts = venue?.split(',').map((s) => s.trim()) ?? [];
      const org = cur.ORGANIZER;
      const cn = org && /(?:^|;)CN="?([^";]+)"?/i.exec(org.params)?.[1];
      const mail = org && /^mailto:(.+)$/i.exec(org.value)?.[1];
      const url = cur.URL?.value.trim();
      if (title)
        out.push({
          title,
          starts_at: cur.DTSTART ? icalTime(cur.DTSTART.value) : null,
          venue,
          town: parts.length > 1 ? clip(parts[parts.length - 1], 80) : null,
          niche: nicheOf(title, venue),
          host_name: clip(cn, 120),
          source_url: webUrl(url) ?? calendarUrl,
          contact: mail ? mail.trim() : null,
        });
      cur = null;
    } else if (cur) {
      const p = prop(line);
      if (p.name && !(p.name in cur)) cur[p.name] = { params: p.params, value: p.value };
    }
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
const textOf = (s: string | undefined) =>
  (s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, k: string) => ENTITIES[k] ?? '');

/** RSS items or Atom entries: the title and link, and a date when the title or summary names one. */
export function parseRss(text: string, feedUrl: string | null, now: Date): Extracted[] {
  const out: Extracted[] = [];
  for (const m of text.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi)) {
    const block = m[0];
    const tag = (n: string) => new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`, 'i').exec(block)?.[1];
    const title = clip(textOf(tag('title')));
    if (!title) continue;
    const href = /<link[^>]*href="([^"]+)"/i.exec(block)?.[1] ?? textOf(tag('link')).trim();
    const when = findWhen(`${title} ${textOf(tag('description') ?? tag('summary'))}`, now);
    out.push({
      title,
      starts_at: when?.at ?? null,
      venue: null,
      town: null,
      niche: nicheOf(title),
      host_name: null,
      source_url: webUrl(href) ?? feedUrl,
      contact: null,
    });
  }
  return out;
}

/**
 * One fetch of a calendar or feed: no redirects followed, a size cap read as it streams, a timeout, and
 * never a private, link-local or unique-local address (the host name is resolved first, and every address
 * it resolves to must be public). Loopback stays allowed by default (a calendar served on this machine),
 * except fwd's own port. A caller that brings its own fetch brings its own lookup, or none.
 */
export async function fetchCalendar(
  url: string,
  now: Date,
  get: typeof fetch = fetch,
  o: { lookup?: Lookup; allowLoopback?: boolean } = {},
): Promise<{ source: IntakeSource; events: Extracted[] }> {
  const why = refusedUrl(url);
  if (why) throw new IntakeError(400, why);
  const u = new URL(url);
  const loopback = o.allowLoopback ?? true;
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  const lookup = o.lookup ?? (get === fetch ? systemLookup : null);
  let addrs = [u.hostname];
  if (!privateAddress(u.hostname) && !/^\[|^[\d.]+$/.test(u.hostname) && lookup) {
    try {
      addrs = await lookup(u.hostname);
    } catch (e) {
      throw new IntakeError(502, `could not resolve ${u.hostname}: ${e instanceof Error ? e.message : e}`);
    }
  }
  for (const a of addrs) {
    const kind = privateAddress(a, loopback);
    if (kind)
      throw new IntakeError(400, `${u.hostname} is a ${kind} address; fwd fetches public calendars only`);
    if (privateAddress(a) === 'loopback' && [FWD_PORT, process.env.FW_PORT].includes(port))
      throw new IntakeError(400, 'that address is FlowWeb itself');
  }
  let res: Response;
  try {
    res = await get(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new IntakeError(502, `could not fetch the calendar: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status >= 300 && res.status < 400)
    throw new IntakeError(400, 'the address redirects; give the calendar address it points to');
  if (!res.ok) throw new IntakeError(502, `the calendar answered ${res.status}`);
  const text = await readCapped(res, MAX_FETCH_BYTES);
  if (/BEGIN:VCALENDAR/i.test(text)) return { source: 'ical', events: parseIcal(text, url) };
  if (/<(rss|feed|rdf:RDF)[\s>]/i.test(text)) return { source: 'rss', events: parseRss(text, url, now) };
  throw new IntakeError(400, 'the address is not an iCal calendar or an RSS feed');
}

/** The engine's answer, checked: only the known fields, as short text, with a real date and link. */
export function fromEngine(raw: unknown): Extracted[] {
  const list = Array.isArray(raw) ? raw : [];
  const s = (v: unknown, n = 200) => (typeof v === 'string' ? clip(v, n) : null);
  return list.flatMap((x) => {
    if (typeof x !== 'object' || x === null) return [];
    const o = x as Record<string, unknown>;
    const title = s(o.title);
    if (!title) return [];
    const at = s(o.starts_at, 16);
    const url = s(o.source_url, 500);
    return [
      {
        title,
        starts_at: at && /^\d{4}-\d\d-\d\d(T\d\d:\d\d)?$/.test(at) ? at : null,
        town: s(o.town, 80),
        venue: s(o.venue),
        niche: s(o.niche, 40),
        host_name: s(o.host_name, 120),
        source_url: webUrl(url),
        contact: s(o.contact, 200),
      },
    ];
  });
}

// ---- the queue ------------------------------------------------------------------------------------

export const queuePath = (fwHome: string, flow: string) =>
  join(fwHome, 'flows', flow, 'intake', 'queue.json');

export function loadQueue(fwHome: string, flow: string): IntakeEvent[] {
  try {
    const raw = JSON.parse(readFileSync(queuePath(fwHome, flow), 'utf8')) as { events?: unknown };
    return Array.isArray(raw.events) ? (raw.events as IntakeEvent[]) : [];
  } catch {
    return [];
  }
}

const saveQueue = (fwHome: string, flow: string, events: IntakeEvent[]) =>
  writeJsonAtomic(queuePath(fwHome, flow), { version: 1, events });

/** Queues the events not already queued (or repeated in this batch), each waiting for the Owner. */
export function enqueue(
  fwHome: string,
  flow: string,
  found: Extracted[],
  source: IntakeSource,
  now: Date,
): { added: IntakeEvent[]; duplicates: number } {
  const queue = loadQueue(fwHome, flow);
  const seen = new Set(queue.map(dedupeKey));
  const added: IntakeEvent[] = [];
  let duplicates = 0;
  for (const e of found) {
    const key = dedupeKey(e);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    const id = `evt_${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
    added.push({ ...e, id, source, status: 'needs_check', created_at: now.toISOString(), checked_at: null });
  }
  if (queue.length + added.length > MAX_QUEUE)
    throw new IntakeError(400, `the intake queue holds at most ${MAX_QUEUE} events; check some first`);
  if (added.length) saveQueue(fwHome, flow, [...queue, ...added]);
  return { added, duplicates };
}

/**
 * The Owner's check. ok approves (ready for the Owner to act on by hand) and an approved host joins the
 * flow's lead graph when leads.json exists; not ok rejects. Nothing is published or sent.
 */
export function checkEvent(
  fwHome: string,
  flow: string,
  id: string,
  ok: unknown,
  now: Date,
): { event: IntakeEvent; lead_added: boolean } {
  if (typeof ok !== 'boolean') throw new IntakeError(400, 'ok must be true or false');
  const queue = loadQueue(fwHome, flow);
  const i = queue.findIndex((e) => e.id === id);
  if (i < 0) throw new IntakeError(404, `no queued event ${id}`);
  const event: IntakeEvent = {
    ...(queue[i] as IntakeEvent),
    status: ok ? 'approved' : 'rejected',
    checked_at: now.toISOString(),
  };
  queue[i] = event;
  saveQueue(fwHome, flow, queue);
  return { event, lead_added: ok ? addHostLead(fwHome, flow, event, now) : false };
}

/**
 * Adds the event's host to the flow's lead graph (leads.ts) as a proposed person, only if leads.json
 * exists. The graph dedupes and scores it like any pasted lead; a name already there is left alone.
 */
function addHostLead(fwHome: string, flow: string, e: IntakeEvent, now: Date): boolean {
  if (!e.host_name || !existsSync(leadsPath(fwHome, flow))) return false;
  if (loadGraph(fwHome, flow).nodes.some((n) => norm(n.name) === norm(e.host_name))) return false;
  const kind = e.contact && EMAIL_RE.test(e.contact) ? 'email' : 'form';
  const node: LeadNode = {
    id: `lead_${createHash('sha256')
      .update(`intake:${norm(e.host_name)}`)
      .digest('hex')
      .slice(0, 12)}`,
    kind: 'person',
    name: e.host_name,
    niche: e.niche,
    town: e.town,
    contact_routes: e.contact ? [{ kind, value: e.contact, public_source_url: e.source_url }] : [],
    source_url: e.source_url,
    last_event_at: e.starts_at,
    current_tool: null,
    consent_note: null,
    state: 'proposed',
    score: { p_reply: 0, p_publish: 0, leverage: 0, timing: 0, value: 0 },
    links: { venues: [], events: [e.id], referred_by: null },
    warm: null,
    created_at: now.toISOString(),
  };
  return nodesFor(refreshLeads({ fwHome, flow, now, extra: [node] }), [node]).length > 0;
}
