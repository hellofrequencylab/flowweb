// FW-C-041: saved event lead hunts in the neighborhood activation flow. The Owner saves a hunt (what to
// look for, where, links to search first, how often, a cap per run, and whether to build a claim link).
// A due hunt runs inside the flow's cycle: the adapter answers leads.json, and this module, not the
// model, decides who gets a message. Every message ends with the Owner's sign-off, the public page the
// address came from and a one-line opt-out. fwd never sends; Autopilot hands drafts to the outbox.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLOW_KEY, type FlowConfig, type FlowState } from './neighborhood-activation.ts';
import { AdminError, adminDir, writeJsonAtomic } from './neighborhood-admin.ts';
import { noDashes } from './short-links.ts';

const DAY = 86_400_000;
/** FW-C-063: the window a day's intensity counts, short of a day so the next morning's run starts fresh. */
const TODAY_MS = 20 * 3_600_000;
export const MAX_SENDS = 25;
export const MAX_LINKS = 20;
const DEFAULT_SIGN_OFF = 'Daniel Tyack\nFounder, Frequency (frequencylocal.com)';

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
  'found' | 'drafted' | 'blocked' | 'not_public' | 'duplicate' | 'capped' | 'restricted',
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
};

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
  if (body.build !== undefined && typeof body.build !== 'boolean')
    throw new AdminError(400, 'build must be true or false');
  return {
    id: `hnt_${randomBytes(6).toString('hex')}`,
    name,
    looking_for,
    region,
    areas: [...new Set(areas as string[])],
    links: [...new Set(links as string[])],
    every_days: whole(body.every_days, 'every_days', 1, 1, 30),
    max_sends: whole(body.max_sends, 'max_sends', 10, 1, MAX_SENDS),
    build: body.build === true,
    enabled: true,
    created_at: now.toISOString(),
    last_run_at: null,
  };
}

/** The hunts a cycle runs now: asked for by hand, or enabled and due by every_days. */
export function dueHunts(hunts: Hunt[], now: Date): Hunt[] {
  return hunts.filter(
    (h) =>
      !!h.requested_at ||
      (h.enabled &&
        (!h.last_run_at || now.getTime() - Date.parse(h.last_run_at) >= h.every_days * DAY - 3_600_000)),
  );
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
    };
  });
}

/** The host funnel link for a hunt lead, carrying the smart-funnel params Frequency reads. */
export function funnelLink(cfg: FlowConfig, h: Hunt): string {
  const f = cfg.funnels.host;
  const q = new URLSearchParams({ persona: f.persona, region: h.region, src: 'hunt' });
  if (h.areas.length === 1) q.set('area', h.areas[0] as string);
  q.set('utm_source', 'flowweb');
  q.set('utm_medium', 'email');
  q.set('utm_campaign', h.id);
  return `${cfg.offer.url.replace(/\/$/, '')}${f.path}?${q}`;
}

/** The model's words plus what fwd always adds: the link or claim slot, sign-off, source and opt-out. */
export function composeBody(cfg: FlowConfig, h: Hunt, lead: HuntLead): string {
  const signOff = text((cfg as { hunts?: { sign_off?: unknown } }).hunts?.sign_off) || DEFAULT_SIGN_OFF;
  const link = h.build
    ? `I set up a page for your event on Frequency. It is yours to claim: {{claim_url}}`
    : `If you'd like to host on Frequency, start here: ${funnelLink(cfg, h)}`;
  // FW-C-084: no em or en dash survives the model's words.
  return [
    noDashes(lead.body),
    '',
    link,
    '',
    signOff,
    `I found ${lead.organizer.contact_via === 'email' ? 'your address' : 'how to reach you'} on ${lead.organizer.source_url}. Not interested? Reply "no" and I won't write again.`,
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
  const daily = o.perDay ?? Number.POSITIVE_INFINITY;
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
    if (!reachable || !isUrl(source_url) || !lead.body) c.not_public++;
    else if (restrictedLead(lead)) c.restricted++;
    else if (onDoNotContact(o.state.do_not_contact, email, pages)) c.blocked++;
    else if (contacts[key] || (email && contacts[email])) c.duplicate++;
    else if (c.drafted >= h.max_sends || week >= weekly || today >= daily) c.capped++;
    else {
      c.drafted++;
      week++;
      today++;
      contacts[key] = { at: o.now.toISOString(), hunt_id: h.id, event_url: lead.event.url };
      const id = `${h.id}-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
      const send_via = SEND_VIA[contact_via];
      const send_how = sendHow(send_via, byEmail ? email : null, contact_url);
      kept.push({ hunt: h, lead, id, key, send_via, send_how, body: composeBody(o.cfg, h, lead) });
    }
  }
  return { kept, counts };
}

export const HUNTS_FLOW = FLOW_KEY;
