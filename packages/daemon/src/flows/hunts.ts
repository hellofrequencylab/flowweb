// FW-C-041: saved event lead hunts in the neighborhood activation flow. The Owner saves a hunt (what to
// look for, where, links to search first, how often, a cap per run, and whether to build a claim link).
// A due hunt runs inside the flow's cycle: the adapter answers leads.json, and this module, not the
// model, decides who gets a message. Every message ends with the Owner's sign-off, the public page the
// address came from and a one-line opt-out. fwd never sends; Autopilot hands drafts to the outbox.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  angleOf,
  FLOW_KEY,
  type FlowConfig,
  type FlowState,
  localOf,
  signOffOf,
  slug,
  WORDS,
  wordCount,
} from './neighborhood-activation.ts';
import { AdminError, adminDir, writeJsonAtomic } from './neighborhood-admin.ts';
import { noDashes } from './short-links.ts';

const DAY = 86_400_000;
/** FW-C-063: the window a day's intensity counts, short of a day so the next morning's run starts fresh. */
const TODAY_MS = 20 * 3_600_000;
export const MAX_SENDS = 25;
export const MAX_LINKS = 20;

// FW-C-101: sites a hunt never fetches (platform terms). A handle seen in search results may still be a contact route.
export const NEVER_FETCH = ['instagram.com', 'instagr.am', 'facebook.com', 'fb.com', 'fb.me'];

/** True when fwd or a hunt cycle may read this page: an http(s) URL not on instagram.com or facebook.com. */
export function fetchAllowed(url: string): boolean {
  if (!/^https?:\/\//i.test(url) || !URL.canParse(url)) return false;
  const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  return !NEVER_FETCH.some((d) => host === d || host.endsWith(`.${d}`));
}

export type Hunt = {
  id: string;
  name: string;
  looking_for: string;
  region: string;
  areas: string[];
  links: string[];
  every_days: number;
  max_sends: number;
  build: boolean;
  enabled: boolean;
  created_at: string;
  last_run_at: string | null;
  /** Set by POST .../hunts/{id}/run: the next cycle runs this hunt even when it is not due. */
  requested_at?: string | null;
};
export type HuntCounts = Record<
  'found' | 'drafted' | 'blocked' | 'not_public' | 'duplicate' | 'capped' | 'restricted' | 'too_long',
  number
>;
/** FW-C-052: how the organizer can be reached, as the lead says. */
export type ContactVia = 'email' | 'form' | 'social' | 'platform';
/** FW-C-052: how the Owner sends a draft. Only email may go to the outbox; the rest are sent by hand. */
export type SendVia = 'email' | 'contact_form' | 'social_dm' | 'platform_message';
const SEND_VIA: Record<ContactVia, SendVia> = {
  email: 'email',
  form: 'contact_form',
  social: 'social_dm',
  platform: 'platform_message',
};
export type HuntLead = {
  hunt_id: string;
  event: { title: string; starts_at: string | null; url: string; country: string | null };
  organizer: {
    name: string | null;
    email: string;
    source_url: string;
    country: string | null;
    contact_via: ContactVia;
    contact_url: string | null;
  };
  subject: string | null;
  body: string;
  /** FW-C-101: the niche and angle the note was written for, from config.json niches. */
  niche?: string | null;
  angle?: string | null;
};
/** FW-C-101: the message format a send route takes. A social or platform message is a DM. */
export type DraftRoute = 'email' | 'form' | 'dm';
export const routeOf = (v: ContactVia): DraftRoute =>
  v === 'email' ? 'email' : v === 'form' ? 'form' : 'dm';

/**
 * FW-C-052: places where most cold messages need consent first (GDPR and ePrivacy in the EU and EEA,
 * PECR in the UK, CASL in Canada). A hunt writes to nobody there.
 */
export const RESTRICTED_COUNTRIES = new Set(
  (
    'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE ' + // EU
    'IS LI NO ' + // EEA
    'GB CA'
  )
    .split(' ')
    .filter(Boolean),
);
const RESTRICTED_TLDS = new Set(
  [...RESTRICTED_COUNTRIES].map((c) => c.toLowerCase()).concat(['eu', 'uk', 'el']),
);

const tldOf = (host: string) => host.toLowerCase().replace(/\.$/, '').split('.').pop() ?? '';
const hostOf = (u: string) => (URL.canParse(u) ? new URL(u).hostname : '');

/** True when the lead's country or any of its addresses or pages points at a restricted place. */
export function restrictedLead(lead: HuntLead): boolean {
  if ([lead.event.country, lead.organizer.country].some((c) => c && RESTRICTED_COUNTRIES.has(c))) return true;
  const hosts = [
    lead.organizer.email.split('@')[1] ?? '',
    ...[lead.organizer.contact_url, lead.organizer.source_url, lead.event.url].map((u) => hostOf(u ?? '')),
  ].filter(Boolean);
  return hosts.some((h) => RESTRICTED_TLDS.has(tldOf(h)));
}

/** One sentence telling the Owner how to send a draft. */
export function sendHow(via: SendVia, to: string | null, page: string | null): string {
  if (via === 'email') return `Email it to ${to} from your own mailbox.`;
  if (via === 'contact_form') return `Paste it into the contact form at ${page}, by hand.`;
  if (via === 'social_dm') return `Send it as a direct message on ${page}, by hand.`;
  return `Send it with the event platform's message button on ${page}, by hand.`;
}
/** Who a hunt has already drafted for, by lower-case address. Kept in the flow's state.json. */
export type HuntContacts = Record<string, { at: string; hunt_id: string; event_url: string }>;

type Row = Record<string, unknown>;
const isObj = (x: unknown): x is Row => typeof x === 'object' && x !== null && !Array.isArray(x);
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const isUrl = (s: string) => /^https?:\/\/\S+$/i.test(s) && URL.canParse(s);
const EMAIL = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/;

export const huntsPath = (fwHome: string) => join(adminDir(fwHome), 'hunts.json');

export function loadHunts(fwHome: string): Hunt[] {
  const p = huntsPath(fwHome);
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    const list = isObj(raw) && Array.isArray(raw.hunts) ? raw.hunts : [];
    return list.filter(isObj) as unknown as Hunt[];
  } catch {
    return [];
  }
}

export function saveHunts(fwHome: string, hunts: Hunt[]): void {
  writeJsonAtomic(huntsPath(fwHome), { version: 1, hunts });
}

function whole(v: unknown, name: string, dflt: number, min: number, max: number): number {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    throw new AdminError(400, `${name} must be a whole number from ${min} to ${max}`);
  return v;
}

/** A new hunt from the Owner's body, checked against the flow's regions. Throws AdminError(400). */
export function newHunt(cfg: FlowConfig, body: Row, now: Date): Hunt {
  const name = text(body.name);
  const looking_for = text(body.looking_for);
  const region = text(body.region);
  if (!name || name.length > 120) throw new AdminError(400, 'name is required (at most 120 characters)');
  if (!looking_for || looking_for.length > 500)
    throw new AdminError(400, 'looking_for is required (at most 500 characters)');
  const t = cfg.territories.find((x) => x.id === region);
  if (!t) throw new AdminError(400, `region must be one of ${cfg.territories.map((x) => x.id).join(', ')}`);
  const areas = body.areas === undefined ? [] : body.areas;
  if (!Array.isArray(areas) || !areas.every((a) => t.sub_areas.some((s) => s.id === a)))
    throw new AdminError(400, `areas must be sub-areas of ${t.name}`);
  const links = body.links === undefined ? [] : body.links;
  if (
    !Array.isArray(links) ||
    links.length > MAX_LINKS ||
    !links.every((l) => typeof l === 'string' && isUrl(l))
  )
    throw new AdminError(400, `links must be at most ${MAX_LINKS} http or https addresses`);
  if (!(links as string[]).every(fetchAllowed))
    throw new AdminError(400, `links may not point at ${NEVER_FETCH.join(', ')}: hunts never fetch them`);
  if (body.build !== undefined && typeof body.build !== 'boolean')
    throw new AdminError(400, 'build must be true or false');
  return {
    id: `hnt_${randomBytes(6).toString('hex')}`,
    name,
    looking_for,
    region,
    areas: [...new Set(areas as string[])],
    links: [...new Set(links as string[])],
    every_days: whole(body.every_days, 'every_days', huntDefaults(cfg).every_days, 1, 30),
    max_sends: whole(body.max_sends, 'max_sends', 10, 1, MAX_SENDS),
    build: body.build === true,
    enabled: true,
    created_at: now.toISOString(),
    last_run_at: null,
  };
}

const huntDefaults = (cfg: FlowConfig) => {
  const n = (cfg as { hunts?: { every_days?: unknown } }).hunts?.every_days;
  return { every_days: typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 30 ? n : 1 };
};

/** The hunts a cycle runs now: asked for by hand, or enabled and due by every_days. Links fwd never fetches are left out. */
export function dueHunts(hunts: Hunt[], now: Date): Hunt[] {
  const due = hunts.filter(
    (h) =>
      !!h.requested_at ||
      (h.enabled &&
        (!h.last_run_at || now.getTime() - Date.parse(h.last_run_at) >= h.every_days * DAY - 3_600_000)),
  );
  return due.map((h) => (Array.isArray(h.links) ? { ...h, links: h.links.filter(fetchAllowed) } : h));
}

/** True when a do-not-contact entry names this address, its @domain, the event or the source page. */
export function onDoNotContact(dnc: string[], email: string, urls: string[]): boolean {
  const set = new Set(dnc.map((x) => x.trim().toLowerCase()));
  const e = email.toLowerCase();
  const byAddress =
    e.includes('@') && (set.has(e) || set.has(`mailto:${e}`) || set.has(`@${e.split('@')[1]}`));
  return byAddress || urls.some((u) => set.has(u.toLowerCase()));
}

/** The leads the adapter answered, shaped; anything that is not a lead object is left out. */
export function parseLeads(raw: unknown): HuntLead[] {
  const list = isObj(raw) && Array.isArray(raw.leads) ? raw.leads : [];
  return list.filter(isObj).map((l) => {
    const ev = isObj(l.event) ? l.event : {};
    const org = isObj(l.organizer) ? l.organizer : {};
    const country = (v: unknown) => (/^[A-Za-z]{2}$/.test(text(v)) ? text(v).toUpperCase() : null);
    const via = text(org.contact_via).toLowerCase();
    const contact_via: ContactVia = via in SEND_VIA ? (via as ContactVia) : 'email';
    const email = text(org.email).toLowerCase();
    const contact_url = text(org.contact_url) || null;
    const tag = (v: unknown) => slug(text(v)) || null;
    return {
      hunt_id: text(l.hunt_id),
      event: {
        title: text(ev.title),
        starts_at: text(ev.starts_at) || null,
        url: text(ev.url),
        country: country(ev.country),
      },
      organizer: {
        name: text(org.name) || null,
        email,
        // A form or profile is itself the public page the contact was found on, unless the lead names another.
        source_url: text(org.source_url) || (contact_via !== 'email' && contact_url ? contact_url : ''),
        country: country(org.country),
        contact_via,
        contact_url,
      },
      subject: text(l.subject) || null,
      body: typeof l.body === 'string' ? l.body.trim() : '',
      niche: tag(l.niche),
      angle: tag(l.angle),
    };
  });
}

/**
 * The host funnel link for a hunt lead, carrying the smart-funnel params Frequency reads. A DM (FW-C-101)
 * goes through the one DM door with no persona, its niche, and utm_medium=one-to-one. utm_campaign stays
 * the hunt id and utm_content the draft tag, because outcomes and CRM sync key on them (FW-C-054).
 */
export function funnelLink(cfg: FlowConfig, h: Hunt, dm?: { niche?: string | null }): string {
  const f = cfg.funnels.host;
  const q = new URLSearchParams(
    dm ? { region: h.region, src: 'hunt' } : { persona: f.persona, region: h.region, src: 'hunt' },
  );
  if (h.areas.length === 1) q.set('area', h.areas[0] as string);
  if (dm?.niche) q.set('niche', dm.niche);
  q.set('utm_source', 'flowweb');
  q.set('utm_medium', dm ? 'one-to-one' : 'email');
  q.set('utm_campaign', h.id);
  const path = dm ? (cfg.dm_door?.path ?? f.path) : f.path;
  return `${cfg.offer.url.replace(/\/$/, '')}${path}?${q}`;
}

/**
 * The model's words plus what fwd always adds. An email or form note: the link or claim slot, the Owner's
 * sign-off and a P.S. with source and opt-out. A DM (FW-C-101): the link or claim slot and one short line
 * naming the source and the opt-out, with no sign-off and no P.S.
 */
export function composeBody(cfg: FlowConfig, h: Hunt, lead: HuntLead): string {
  const [signOff, local] = [signOffOf(cfg), localOf(cfg)];
  const found = lead.organizer.contact_via === 'email' ? 'your address' : 'how to reach you';
  const dm = routeOf(lead.organizer.contact_via) === 'dm';
  const claim = `I set up a page for your event on Frequency. It is yours to claim: {{claim_url}}`;
  // FW-C-084: no em or en dash survives the model's words.
  if (dm)
    return [
      noDashes(lead.body),
      '',
      h.build ? claim : funnelLink(cfg, h, { niche: lead.niche ?? null }),
      '',
      `Found you on ${lead.organizer.source_url}. Not for you? Just reply "no" and I won't write again.`,
    ].join('\n');
  const link = h.build ? claim : `If you'd like to host on Frequency, start here: ${funnelLink(cfg, h)}`;
  return [
    noDashes(lead.body),
    '',
    link,
    '',
    signOff,
    '',
    `P.S. I'm local to ${local} and found ${found} on ${lead.organizer.source_url}. If you aren't interested, just reply "no" and I won't reach out again.`,
  ].join('\n');
}

export type Kept = {
  hunt: Hunt;
  lead: HuntLead;
  id: string;
  body: string;
  /** The address or page fwd remembers this contact by. */
  key: string;
  send_via: SendVia;
  send_how: string;
  /** FW-C-101: what the draft was written for and how it reads. */
  niche: string | null;
  angle: string | null;
  route: DraftRoute;
};

/**
 * Decides who gets a message. In order: not one of the due hunts, no address (or public contact page)
 * or no public source page (not_public), in the EU or EEA, the UK or Canada (restricted, FW-C-052), on
 * do-not-contact (blocked), drafted for before (duplicate), over the hunt's cap, the flow's weekly cap or
 * the Owner's people a day (capped). Pure: the caller records the kept ones as contacts.
 */
export function screenLeads(o: {
  cfg: FlowConfig;
  state: FlowState & { hunt_contacts?: HuntContacts };
  hunts: Hunt[];
  leads: HuntLead[];
  now: Date;
  /** FW-C-063: new people a day, counted over the last 20 hours so each morning starts fresh. */
  perDay?: number;
}): { kept: Kept[]; counts: Record<string, HuntCounts> } {
  const contacts = { ...(o.state.hunt_contacts ?? {}) };
  const t = o.now.getTime();
  let week = Object.values(contacts).filter((c) => t - Date.parse(c.at) < 7 * DAY).length;
  let today = Object.values(contacts).filter((c) => t - Date.parse(c.at) < TODAY_MS).length;
  // FW-C-101: without the Owner's intensity, the flow's own default (leads.max_new_contacts_per_day) holds.
  const daily = o.perDay ?? o.cfg.leads.max_new_contacts_per_day ?? Number.POSITIVE_INFINITY;
  const weekly = o.cfg.leads.max_new_invites_per_week;
  const counts: Record<string, HuntCounts> = {};
  for (const h of o.hunts)
    counts[h.id] = {
      found: 0,
      drafted: 0,
      blocked: 0,
      not_public: 0,
      duplicate: 0,
      capped: 0,
      restricted: 0,
      too_long: 0,
    };
  const kept: Kept[] = [];
  for (const lead of o.leads) {
    const h = o.hunts.find((x) => x.id === lead.hunt_id);
    const c = h ? counts[h.id] : undefined;
    if (!h || !c) continue;
    c.found++;
    const { email, source_url, contact_via, contact_url } = lead.organizer;
    const byEmail = contact_via === 'email';
    const reachable = byEmail
      ? EMAIL.test(email)
      : !!contact_url && /^https:\/\/\S+$/i.test(contact_url) && isUrl(contact_url);
    const key = byEmail ? email : (contact_url ?? '').toLowerCase();
    const pages = [source_url, lead.event.url, ...(contact_url ? [contact_url] : [])];
    const route = routeOf(contact_via);
    const body = reachable && lead.body ? composeBody(o.cfg, h, lead) : '';
    if (!reachable || !isUrl(source_url) || !lead.body) c.not_public++;
    else if (restrictedLead(lead)) c.restricted++;
    else if (onDoNotContact(o.state.do_not_contact, email, pages)) c.blocked++;
    else if (contacts[key] || (email && contacts[email])) c.duplicate++;
    else if (route === 'dm' && wordCount(body) > WORDS.hard_cap) c.too_long++;
    else if (c.drafted >= h.max_sends || week >= weekly || today >= daily) c.capped++;
    else {
      c.drafted++;
      week++;
      today++;
      contacts[key] = { at: o.now.toISOString(), hunt_id: h.id, event_url: lead.event.url };
      const id = `${h.id}-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
      const send_via = SEND_VIA[contact_via];
      const send_how = sendHow(send_via, byEmail ? email : null, contact_url);
      const niche = lead.niche ?? null;
      const angle = niche ? angleOf(o.cfg, niche, lead.angle) : (lead.angle ?? null);
      kept.push({ hunt: h, lead, id, key, send_via, send_how, body, niche, angle, route });
    }
  }
  return { kept, counts };
}

export const HUNTS_FLOW = FLOW_KEY;

/**
 * FW-C-101: the hunt brief's v2 lines, from the cycle folder's config.json: the sources a hunt may read,
 * the sites it never fetches, the niches and angles a note is written for, and how long a DM may be.
 */
export function huntRules(dir: string): string[] {
  let cfg: {
    hunts?: { sources?: { allowed?: unknown } };
    niches?: { key?: unknown; angles?: { key?: unknown; line?: unknown }[] }[];
  } = {};
  try {
    cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as typeof cfg;
  } catch {}
  const src = cfg.hunts?.sources?.allowed;
  const allowed = Array.isArray(src) ? src.filter((x): x is string => typeof x === 'string') : [];
  const niches = (Array.isArray(cfg.niches) ? cfg.niches : []).flatMap((n) => {
    const angles = (Array.isArray(n.angles) ? n.angles : [])
      .filter((a) => typeof a.key === 'string' && typeof a.line === 'string')
      .map((a) => `${a.key} (${a.line})`);
    return typeof n.key === 'string' && angles.length > 0 ? [`${n.key}: ${angles.join(', ')}`] : [];
  });
  return [
    ...(allowed.length > 0 ? [`Sources you may read: ${allowed.join('; ')}.`] : []),
    `Never fetch, open or crawl any page on ${NEVER_FETCH.join(', ')}. A handle you see in search results may be kept as a social contact_url, but do not open it. fwd refuses those pages as sources to read.`,
    ...(niches.length > 0
      ? [
          `Give every lead a niche and an angle (the pain point the note leads with) from this list, as "niche" and "angle" in leads.json: ${niches.join('; ')}. Use niche "venue" for a studio or venue.`,
        ]
      : []),
    `A note to a social or platform contact is a DM: aim for ${WORDS.dm - 15} words of your own (fwd adds the link and one short line), never more than ${WORDS.hard_cap - 30}; fwd drops a DM over ${WORDS.hard_cap} words. A DM has no sign-off and no P.S.`,
  ];
}
