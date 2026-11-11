// FW-C-103: the lead graph. Every lead is a scored node (a person or a venue) in a small graph kept in
// $FW_HOME/flows/<flow>/leads.json, linked to the venues they teach at, the events they run and the
// person who referred them. Nodes come from the drafts the hunts already write (read only) and from the
// people the Owner met in person (a paste). Score: value = p_reply x p_publish x leverage x timing.
// A strong node approves itself, a borderline one waits for the Owner, a weak one drops. Do-not-contact
// and restricted regions always drop. Pasted text and scraped fields are data, never instructions.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadHunts, onDoNotContact, RESTRICTED_COUNTRIES } from './hunts.ts';
import { writeJsonAtomic } from './neighborhood-admin.ts';

const DAY = 86_400_000;
export type LeadState = 'proposed' | 'approved' | 'dropped';
export type Route = { kind: 'email' | 'dm' | 'form'; value: string; public_source_url: string | null };
export type Score = { p_reply: number; p_publish: number; leverage: number; timing: number; value: number };
export type LeadNode = {
  id: string;
  kind: 'person' | 'venue';
  name: string;
  niche: string | null;
  town: string | null;
  contact_routes: Route[];
  source_url: string | null;
  last_event_at: string | null;
  current_tool: string | null;
  consent_note: string | null;
  state: LeadState;
  score: Score;
  links: { venues: string[]; events: string[]; referred_by: string | null };
  warm: 'met_in_person' | 'referred' | null;
  created_at: string;
};
/** A decision that sticks across rescoring: the Owner's tap, or an automatic approval already made. */
type Decision = { state: LeadState; by: 'owner' | 'auto'; at: string };
export type LeadGraph = { version: 1; nodes: LeadNode[]; decisions: Record<string, Decision> };
export type LeadRules = { approve_at: number; borderline_at: number; half_life_days: number };
export const DEFAULT_RULES: LeadRules = { approve_at: 0.6, borderline_at: 0.45, half_life_days: 21 };

type Row = Record<string, unknown>;
const isObj = (x: unknown): x is Row => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const hostOf = (u: string | null) =>
  u && URL.canParse(u) ? new URL(u).hostname.toLowerCase().replace(/^www\./, '') : '';
const EMAIL = /[^@\s<>"(),;]+@[^@\s<>"(),;]+\.[a-z]{2,}/i;
const HANDLE = /(?:^|\s)@([a-z0-9_.]{2,30})\b/i;

export const leadsPath = (fwHome: string, flow: string) => join(fwHome, 'flows', flow, 'leads.json');

export function loadGraph(fwHome: string, flow: string): LeadGraph {
  try {
    const raw = JSON.parse(readFileSync(leadsPath(fwHome, flow), 'utf8')) as unknown;
    if (isObj(raw) && Array.isArray(raw.nodes))
      return {
        version: 1,
        nodes: raw.nodes.filter(isObj) as unknown as LeadNode[],
        decisions: isObj(raw.decisions) ? (raw.decisions as LeadGraph['decisions']) : {},
      };
  } catch {
    // no graph yet, or a broken file: start empty rather than guess
  }
  return { version: 1, nodes: [], decisions: {} };
}

/** Platforms a host uses today. Ticket sellers mean fees Frequency removes. */
const TOOLS: [RegExp, string, boolean][] = [
  [/eventbrite\./, 'eventbrite', true],
  [/(^|\.)lu\.ma$|luma\.com/, 'luma', true],
  [/meetup\.com/, 'meetup', false],
  [/partiful\.com/, 'partiful', false],
  [/mindbodyonline\.com|mindbody\.io/, 'mindbody', true],
  [/momence\.com/, 'momence', true],
  [/ticketleap|ticketmaster|tixr|universe\.com|withjoy|posh\.vip/, 'tickets', true],
  [/instagram\.com/, 'instagram', false],
  [/facebook\.com/, 'facebook', false],
];
const toolOf = (url: string | null) => TOOLS.find(([re]) => re.test(hostOf(url)))?.[1] ?? null;
const sellsTickets = (tool: string | null) => TOOLS.some(([, t, paid]) => t === tool && paid);
/** Sites many people share: a page there says nothing about whose site it is. */
const SHARED_HOSTS =
  /(eventbrite|lu\.ma|luma|meetup|partiful|mindbody|momence|instagram|facebook|linktr\.ee|google|yelp|allevents|patch\.com|nextdoor|tiktok|x\.com|twitter)/;
const FREE_MAIL = new Set(
  'gmail.com yahoo.com hotmail.com outlook.com icloud.com aol.com me.com proton.me'.split(' '),
);

const normEmail = (e: string) => {
  const [u = '', d = ''] = e.toLowerCase().trim().split('@');
  return d ? `${u.replace(/\+.*$/, '')}@${d}` : '';
};
const normName = (s: string) =>
  s
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.join(' ') ?? '';
const handleOf = (r: Route) => {
  if (r.kind !== 'dm') return '';
  const m = /^@?([a-z0-9_.]{2,30})$/i.exec(r.value) ?? /\.com\/@?([a-z0-9_.]{2,30})\/?$/i.exec(r.value);
  return m ? (m[1] as string).toLowerCase() : '';
};
/** The node's own website domain: only a venue owns its site, and never a shared platform. */
const ownDomain = (n: LeadNode) => {
  if (n.kind !== 'venue') return '';
  const site = hostOf(n.source_url);
  if (site && !SHARED_HOSTS.test(site)) return site;
  const mail = n.contact_routes.find((r) => r.kind === 'email')?.value.split('@')[1] ?? '';
  return mail && !FREE_MAIL.has(mail) ? mail : '';
};

/** Dedupe keys, namespaced by kind so a teacher never merges with the studio she teaches at. */
export function keysOf(n: LeadNode): string[] {
  const k = [
    ...n.contact_routes.filter((r) => r.kind === 'email').map((r) => `email:${normEmail(r.value)}`),
    ...n.contact_routes
      .map(handleOf)
      .filter(Boolean)
      .map((h) => `handle:${h}`),
    ...(ownDomain(n) ? [`domain:${ownDomain(n)}`] : []),
    // A warm name the Owner met may come without a town; it still dedupes on a second paste.
    ...((n.town || n.warm) && n.name ? [`name:${normName(n.name)}|${normName(n.town ?? '')}`] : []),
  ];
  return k.map((x) => `${n.kind}/${x}`);
}

const union = <T>(a: T[], b: T[]) => [...new Set([...a, ...b])];
const later = (a: string | null, b: string | null) =>
  !a ? b : !b ? a : Date.parse(a) >= Date.parse(b) ? a : b;
const warmer = (a: LeadNode['warm'], b: LeadNode['warm']) =>
  a === 'met_in_person' || b === 'met_in_person' ? 'met_in_person' : (a ?? b);

function merge(a: LeadNode, b: LeadNode): LeadNode {
  const routes = [...a.contact_routes];
  for (const r of b.contact_routes)
    if (!routes.some((x) => x.kind === r.kind && x.value.toLowerCase() === r.value.toLowerCase()))
      routes.push(r);
  return {
    ...a,
    niche: a.niche ?? b.niche,
    town: a.town ?? b.town,
    contact_routes: routes,
    source_url: a.source_url ?? b.source_url,
    last_event_at: later(a.last_event_at, b.last_event_at),
    current_tool: a.current_tool ?? b.current_tool,
    consent_note: a.consent_note ?? b.consent_note,
    links: {
      venues: union(a.links.venues, b.links.venues),
      events: union(a.links.events, b.links.events),
      referred_by: a.links.referred_by ?? b.links.referred_by,
    },
    warm: warmer(a.warm, b.warm),
    created_at: [a.created_at, b.created_at].sort()[0] ?? a.created_at,
  };
}

/** Adds a node, or folds it into every node it shares a key with (the oldest keeps its id). */
export function upsert(g: LeadGraph, n: LeadNode): LeadNode {
  const keys = new Set(keysOf(n));
  const hits = g.nodes.filter((x) => keysOf(x).some((k) => keys.has(k)));
  if (hits.length === 0) {
    g.nodes.push(n);
    return n;
  }
  const [first, ...rest] = hits as [LeadNode, ...LeadNode[]];
  let m = merge(first, n);
  for (const x of rest) m = merge(m, x);
  const gone = new Set(rest.map((x) => x.id));
  g.nodes = g.nodes.filter((x) => !gone.has(x.id)).map((x) => (x.id === first.id ? m : x));
  for (const x of g.nodes) {
    x.links.venues = x.links.venues.map((v) => (gone.has(v) ? first.id : v));
    if (x.links.referred_by && gone.has(x.links.referred_by)) x.links.referred_by = first.id;
  }
  return m;
}

const WARM = { met_in_person: 0.95, referred: 0.85 } as const;
const ZERO: Score = { p_reply: 0, p_publish: 0, leverage: 1, timing: 0, value: 0 };
function blank(kind: LeadNode['kind'], name: string, now: Date, seed: string): LeadNode {
  const id = `ld_${createHash('sha256').update(`${kind}|${seed}`).digest('hex').slice(0, 12)}`;
  return {
    id,
    kind,
    name,
    niche: null,
    town: null,
    contact_routes: [],
    source_url: null,
    last_event_at: null,
    current_tool: null,
    consent_note: null,
    state: 'proposed',
    score: { ...ZERO },
    links: { venues: [], events: [], referred_by: null },
    warm: null,
    created_at: now.toISOString(),
  };
}

/** One draft file the hunts wrote, as a node. Fields the draft does not carry stay null. */
export function nodeFromDraft(d: Row, now: Date, huntNiche: (id: string) => string | null): LeadNode | null {
  const name = str(d.name) || str(isObj(d.venue) ? d.venue.name : '');
  const to = str(d.to);
  const contact = str(d.contact_url);
  const source = str(d.source_url) || null;
  if (!name && !to && !contact) return null;
  const kind = str(d.kind) === 'venue' ? 'venue' : 'person';
  const n = blank(kind, name || to || contact, now, to || contact || name);
  const via = str(d.send_via);
  if (to) n.contact_routes.push({ kind: 'email', value: to.toLowerCase(), public_source_url: source });
  if (contact)
    n.contact_routes.push({
      kind: via === 'contact_form' ? 'form' : 'dm',
      value: contact,
      public_source_url: source,
    });
  const ev = isObj(d.event) ? d.event : {};
  n.niche = str(d.niche) || huntNiche(str(d.hunt_id)) || null;
  n.town = str(d.town) || str(d.area) || str(d.region) || null;
  n.source_url = source;
  n.last_event_at = str(ev.starts_at) || null;
  n.current_tool = toolOf(str(ev.url) || source);
  n.consent_note = source ? `Public contact found on ${source}` : null;
  if (str(ev.url)) n.links.events.push(str(ev.url));
  n.created_at = str(d.created_at) || n.created_at;
  return n;
}

/** Lines the Owner pasted of people met in person: "name, where met, contact". Text is data. */
export function parsePaste(text: string, now: Date, town: string | null = null): LeadNode[] {
  const out: LeadNode[] = [];
  for (const raw of text.split(/\r?\n/).slice(0, 200)) {
    const line = raw
      .replace(/^\s*(?:[-*]|\d+[.)])\s+/, '')
      .trim()
      .slice(0, 300);
    if (!line) continue;
    const parts = line.split(/\s*[,;|\t]\s*|\s+[-–—]\s+/).filter(Boolean);
    const name = (parts.shift() ?? '').replace(EMAIL, '').trim();
    if (!name || name.length > 80) continue;
    const n = blank('person', name, now, `paste|${normName(name)}|${normName(town ?? '')}`);
    const email = EMAIL.exec(line)?.[0];
    const handle = HANDLE.exec(` ${line}`)?.[1];
    const url = /https?:\/\/\S+/i.exec(line)?.[0];
    if (email) n.contact_routes.push({ kind: 'email', value: email.toLowerCase(), public_source_url: null });
    if (handle)
      n.contact_routes.push({ kind: 'dm', value: `@${handle.toLowerCase()}`, public_source_url: null });
    else if (url) n.contact_routes.push({ kind: 'dm', value: url, public_source_url: null });
    const where = parts
      .filter((p) => !EMAIL.test(p) && !p.startsWith('@') && !/^https?:/i.test(p))
      .join(', ');
    const ref = /\b(?:referred by|via|intro from)\s+([^,;|]+)/i.exec(line)?.[1]?.trim() ?? null;
    n.warm = ref ? 'referred' : 'met_in_person';
    n.town = town;
    n.consent_note = ref ? `Referred by ${ref}` : `Met in person${where ? `: ${where}` : ''}`;
    n.links.referred_by = ref ? `name:${normName(ref)}` : null;
    n.last_event_at = now.toISOString();
    out.push(n);
  }
  return out;
}

const tldOf = (u: string | null) => hostOf(u).split('.').pop() ?? '';
const restricted = (n: LeadNode) =>
  [n.source_url, ...n.links.events, ...n.contact_routes.map((r) => r.value.replace(/^[^@/]*@/, 'https://'))]
    .map(tldOf)
    .some((tld) => RESTRICTED_COUNTRIES.has(tld.toUpperCase()) || tld === 'uk' || tld === 'eu');

/** Scores every node and sets its state. Pure apart from the graph it is given. */
export function scoreGraph(g: LeadGraph, rules: LeadRules, dnc: string[], now: Date): LeadGraph {
  // Teachers link to a venue whose own site is the page they were found on.
  const venues = new Map(
    g.nodes.filter((n) => n.kind === 'venue' && ownDomain(n)).map((n) => [ownDomain(n), n.id]),
  );
  for (const n of g.nodes) {
    const v = n.kind === 'person' ? venues.get(hostOf(n.source_url)) : undefined;
    if (v && !n.links.venues.includes(v)) n.links.venues.push(v);
    const ref = n.links.referred_by;
    if (ref?.startsWith('name:'))
      n.links.referred_by =
        g.nodes.find((x) => x.id !== n.id && `name:${normName(x.name)}` === ref)?.id ?? ref;
  }
  const teachers = (id: string) => g.nodes.filter((x) => x.links.venues.includes(id)).length;
  const referrals = (id: string) => g.nodes.filter((x) => x.links.referred_by === id).length;
  for (const n of g.nodes) {
    const own = n.contact_routes.some((r) => r.public_source_url || n.warm);
    const age = n.last_event_at ? (now.getTime() - Date.parse(n.last_event_at)) / DAY : Number.NaN;
    const recent = Number.isFinite(age) && age < 30;
    // P(reply): warm beats cold; then the route, a public contact that is theirs, and recent activity.
    const route = n.contact_routes.some((r) => r.kind === 'email')
      ? 0.15
      : n.contact_routes.length
        ? 0.1
        : -0.3;
    const cold = clamp(0.5 + route + (own ? 0 : -0.2) + (recent ? 0.1 : 0), 0, 0.9);
    const p_reply = n.warm ? WARM[n.warm] : cold;
    // P(publish | reply): recurring events, ticket fees Frequency removes, and a known niche.
    const recurring = n.links.events.length > 1 ? 0.15 : 0;
    const fees = sellsTickets(n.current_tool) ? 0.1 : 0;
    const p_publish = clamp(0.65 + recurring + fees + (n.niche ? 0.05 : 0), 0, 0.95);
    const others =
      n.kind === 'venue' ? 0.25 * teachers(n.id) : 0.1 * n.links.venues.length + 0.2 * referrals(n.id);
    const leverage = clamp(1 + others + 0.05 * Math.max(0, n.links.events.length - 1), 1, 2);
    const timing = !Number.isFinite(age) ? 0.5 : age <= 0 ? 1 : 0.5 ** (age / rules.half_life_days);
    const value = clamp(p_reply * p_publish * leverage * timing, 0, 1);
    const parts = { p_reply, p_publish, leverage, timing, value };
    n.score = Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, r3(v)])) as Score;
    const emails = n.contact_routes.filter((r) => r.kind === 'email').map((r) => r.value);
    const pages = [n.source_url ?? '', ...n.links.events, ...n.contact_routes.map((r) => r.value)];
    const blocked =
      (emails.length ? emails : ['']).some((e) => onDoNotContact(dnc, e, pages)) || restricted(n);
    const d = g.decisions[n.id];
    if (blocked) n.state = 'dropped';
    else if (d) n.state = d.state;
    else if (value >= rules.approve_at) {
      n.state = 'approved';
      g.decisions[n.id] = { state: 'approved', by: 'auto', at: now.toISOString() };
    } else n.state = value >= rules.borderline_at ? 'proposed' : 'dropped';
  }
  return g;
}

export type LeadDeps = { fwHome: string; flow: string; rules?: LeadRules; now?: Date };
const dncOf = (fwHome: string, flow: string): string[] => {
  try {
    const s = JSON.parse(readFileSync(join(fwHome, 'flows', flow, 'state.json'), 'utf8')) as Row;
    return Array.isArray(s.do_not_contact)
      ? s.do_not_contact.filter((x): x is string => typeof x === 'string')
      : [];
  } catch {
    return [];
  }
};

/** Ingests the flow's hunt drafts (read only), rescores and saves. Runs after each hunt cycle and daily. */
export function refreshLeads(o: LeadDeps & { extra?: LeadNode[] }): LeadGraph {
  const now = o.now ?? new Date();
  const g = loadGraph(o.fwHome, o.flow);
  const dir = join(o.fwHome, 'flows', o.flow, 'drafts');
  const hunts = loadHunts(o.fwHome);
  const niche = (id: string) => hunts.find((h) => h.id === id)?.looking_for ?? null;
  for (const f of existsSync(dir) ? readdirSync(dir).sort() : []) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown;
      const n = isObj(d) && str(d.hunt_id) ? nodeFromDraft(d, now, niche) : null;
      if (n) upsert(g, n);
    } catch {
      // a half-written or foreign file is not a lead
    }
  }
  for (const n of o.extra ?? []) upsert(g, n);
  scoreGraph(g, o.rules ?? DEFAULT_RULES, dncOf(o.fwHome, o.flow), now);
  writeJsonAtomic(leadsPath(o.fwHome, o.flow), g);
  return g;
}

/** The graph's nodes that the given (pasted) nodes landed in, after dedupe. */
export function nodesFor(g: LeadGraph, added: LeadNode[]): LeadNode[] {
  const keys = new Set(added.flatMap(keysOf));
  return g.nodes.filter((n) => added.some((a) => a.id === n.id) || keysOf(n).some((k) => keys.has(k)));
}

/** The flows the hunts feed, refreshed after each hunt cycle and once a day. A failure is logged, never thrown. */
export function refreshQuietly(fwHome: string, flow: string, cfg: () => unknown, log: (m: string) => void) {
  const dir = join(fwHome, 'flows', flow);
  if (!existsSync(join(dir, 'drafts')) && !existsSync(join(dir, 'leads.json'))) return; // nothing to score yet
  try {
    const g = refreshLeads({ fwHome, flow, rules: rulesOf(cfg()) });
    const by = (s: LeadState) => g.nodes.filter((n) => n.state === s).length;
    log(`leads: ${flow}: ${by('approved')} approved, ${by('proposed')} proposed, ${by('dropped')} dropped`);
  } catch (e) {
    log(`leads: refresh of ${flow} failed: ${(e as Error)?.message ?? e}`);
  }
}

export class LeadError extends Error {
  status: 404 | 409;
  constructor(status: 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

/** The Owner's tap. Approving a node on do-not-contact or in a restricted region is refused. */
export function decideLead(o: LeadDeps & { id: string; state: 'approved' | 'dropped' }): LeadNode {
  const now = o.now ?? new Date();
  const g = loadGraph(o.fwHome, o.flow);
  if (!g.nodes.some((n) => n.id === o.id)) throw new LeadError(404, `lead ${o.id} not found`);
  g.decisions[o.id] = { state: o.state, by: 'owner', at: now.toISOString() };
  scoreGraph(g, o.rules ?? DEFAULT_RULES, dncOf(o.fwHome, o.flow), now);
  const n = g.nodes.find((x) => x.id === o.id) as LeadNode;
  if (n.state !== o.state)
    throw new LeadError(409, 'this lead is on do-not-contact or in a restricted region, so it stays dropped');
  writeJsonAtomic(leadsPath(o.fwHome, o.flow), g);
  return n;
}

/** Rules from a flow's config.leads, falling back to the defaults. */
export function rulesOf(cfgLeads: unknown): LeadRules {
  const l = isObj(cfgLeads) ? cfgLeads : {};
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
  return {
    approve_at: num(l.auto_approve_at, DEFAULT_RULES.approve_at),
    borderline_at: num(l.borderline_at, DEFAULT_RULES.borderline_at),
    half_life_days: num(l.timing_half_life_days, DEFAULT_RULES.half_life_days),
  };
}
