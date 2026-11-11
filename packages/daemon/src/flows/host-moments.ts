// FW-C-106: Host moments. Frequency host events (integration contract v1) become personal notes from the
// Owner that wait in the flow's drafts inbox. Each event is one file in $FW_HOME/flows/host-moments/events/;
// a handled file moves to events/done/. Templates are fixed: event text is cleaned and capped, numbers come
// only from the payload or the facts sheet ($FW_HOME/facts.json), and nothing is ever sent from here.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { noDashes, shortenerFor } from './short-links.ts';

export const FLOW_KEY = 'host-moments';

type R = Record<string, unknown>;
export interface Config {
  offer: { name: string; url: string };
  host_path: string;
  send_via: string;
  send_routes: R;
  intro: string;
  sign_off: string;
  opt_out: string;
  links: { utm_source: string; utm_medium: string; utm_campaign: string };
  share_kit: { utm_medium: string; qr_poster: string };
  timezone: string;
  thank_you_due_hours: number;
  stall_max_age_hours: number;
  facts: { file: string; founding_price: string; founding_ends: string; plan_price: string };
  do_not_contact_flow: string;
}
interface Published {
  event_id: string;
  title: string;
  starts_at: string;
  town: string | null;
  niche: string | null;
  rsvp_url: string;
}
interface State {
  stalls: string[];
  published: Record<string, Published[]>;
  kitted: string[];
  thanked: string[];
  niches: Record<string, string>;
}
export interface Skip {
  file: string;
  type: string;
  reason: string;
}
export interface ScanReport {
  processed: number;
  drafts: { id: string; kind: string }[];
  skipped: Skip[];
  blocked: string[];
}
type Moment = { kind: string; subject: string; note: string; kit?: string; name?: string; due_at?: string };

const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));
const isObj = (x: unknown): x is R => typeof x === 'object' && x !== null && !Array.isArray(x);

function writeAtomic(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** The flow: stream.json from the repo, config.json overridable from $FW_HOME. Null when not shipped. */
export function loadFlow(repoRoot: string, fwHome: string) {
  const repoDir = join(repoRoot, 'flows', FLOW_KEY);
  if (!existsSync(join(repoDir, 'stream.json'))) return null;
  const override = join(fwHome, 'flows', FLOW_KEY, 'config.json');
  const cfg = readJson(existsSync(override) ? override : join(repoDir, 'config.json')) as Config;
  const stream = readJson(join(repoDir, 'stream.json')) as R;
  const sb = (stream.budget ?? {}) as { period?: string; caps?: { max_usd?: number; max_turns?: number } };
  const budget = {
    period: sb.period ?? 'week',
    max_usd: sb.caps?.max_usd ?? null,
    max_turns: sb.caps?.max_turns ?? null,
  };
  return { cfg, stream, budget };
}

/** Event text is data: one line, no links, no control characters, no emoji or dashes, capped. */
function clean(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = noDashes(v)
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\p{Cc}\p{Extended_Pictographic}{}<>]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s ? s.slice(0, max).trim() : null;
}
const firstName = (v: unknown) => {
  const s = clean(v, 40);
  return s && /^\p{L}[\p{L} .']*$/u.test(s) ? s : null;
};
const count = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
const slug = (v: unknown) => {
  const s =
    typeof v === 'string'
      ? v
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
      : '';
  return s ? s.slice(0, 40) : null;
};
const https = (v: unknown) => {
  try {
    const u = new URL(String(v));
    return u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
};

function when(iso: string, tz: string, time: boolean): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' });
  if (!time) return day;
  const t = d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  return `${day} at ${t}`.replace(/\s/g, ' ');
}

/** The facts sheet's value, as written there: a number becomes $n, an ISO date a written date. */
function fact(facts: R | null, key: string, tz: string): string | null {
  const v = facts?.[key];
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return `$${v}`;
  if (typeof v !== 'string' || !v.trim()) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v.trim()))
    return new Date(`${v.trim()}T12:00:00Z`).toLocaleDateString('en-US', {
      timeZone: tz,
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  return clean(v, 60);
}

function readState(path: string): State {
  const raw = existsSync(path) ? readJson(path) : {};
  const s = isObj(raw) ? raw : {};
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  return {
    stalls: list(s.stalls),
    published: isObj(s.published) ? (s.published as State['published']) : {},
    kitted: list(s.kitted),
    thanked: list(s.thanked),
    niches: isObj(s.niches) ? (s.niches as State['niches']) : {},
  };
}

/** The do-not-contact list the creator outreach already keeps (neighborhood-activation state.json). */
function dncPath(fwHome: string, cfg: Config) {
  return join(fwHome, 'flows', cfg.do_not_contact_flow, 'state.json');
}
function readDnc(fwHome: string, cfg: Config): string[] {
  const p = dncPath(fwHome, cfg);
  const s = existsSync(p) ? readJson(p) : null;
  return isObj(s) && Array.isArray(s.do_not_contact) ? s.do_not_contact.map(String) : [];
}

/** Opt-out: the host, and the lead behind the draft that reached them (ref), go on the list today. */
function optOut(fwHome: string, cfg: Config, host: string, ref: string | null): string[] {
  const keys = [`frequency-host:${host}`];
  const tag = ref ? (ref.includes('.') ? ref.slice(ref.indexOf('.') + 1) : ref) : null;
  const dir = join(fwHome, 'flows', cfg.do_not_contact_flow, 'drafts');
  if (tag && existsSync(dir))
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      try {
        const d = readJson(join(dir, f)) as R;
        if (d.tag !== tag) continue;
        const pick = (k: string) => (typeof d[k] === 'string' && d[k] !== '' ? (d[k] as string) : null);
        const k = (pick('to') ?? pick('contact_url') ?? pick('lead_id'))?.toLowerCase();
        if (k && !k.startsWith('template:')) keys.push(k);
      } catch {
        // A draft being written: the host key still blocks them.
      }
    }
  const p = dncPath(fwHome, cfg);
  const raw = existsSync(p) ? readJson(p) : {};
  const s = isObj(raw) ? raw : {};
  const list = Array.isArray(s.do_not_contact) ? s.do_not_contact.map(String) : [];
  const add = keys.filter((k) => !list.includes(k));
  if (add.length) writeAtomic(p, { ...s, do_not_contact: [...list, ...add] });
  return keys;
}

function link(cfg: Config, base: string | URL, niche: string | null, tag: string, medium: string): string {
  const u = new URL(String(base), cfg.offer.url);
  u.searchParams.set('utm_source', cfg.links.utm_source);
  u.searchParams.set('utm_medium', medium);
  u.searchParams.set('utm_campaign', cfg.links.utm_campaign);
  u.searchParams.set('utm_content', niche ? `${niche}.${tag}` : tag);
  if (!u.searchParams.has('ref')) u.searchParams.set('ref', tag);
  return u.toString();
}

function shareKit(cfg: Config, e: Published, tag: string): string {
  const url = link(cfg, e.rsvp_url, e.niche, tag, cfg.share_kit.utm_medium);
  const at = when(e.starts_at, cfg.timezone, true);
  const where = e.town ? ` in ${e.town}` : '';
  return [
    `Share kit for ${e.title}, ready to copy:`,
    `Instagram caption: I'm hosting ${e.title}${where} on ${at}. Come join us, RSVP here: ${url}`,
    `Instagram story text: ${e.title}, ${at}${where}. Tap the link to RSVP: ${url}`,
    `WhatsApp or email: Hi! I'm hosting ${e.title} on ${at}${where}. I'd love for you to come. You can RSVP on Frequency here: ${url}`,
    `QR poster link: ${cfg.share_kit.qr_poster.replace('{url}', encodeURIComponent(url))}`,
  ].join('\n\n');
}

const KNOWN = new Set(
  'host.started launcher.stalled space.published event.published event.filled event.rsvps_8 event.second meter.80 host.opted_out founding.purchased showcase.consent'.split(
    ' ',
  ),
);
/** Moments that order first: a published event feeds the share kit, an opt-out blocks the rest. */
const FIRST: Record<string, number> = { 'event.published': 0, 'host.opted_out': 1 };

/**
 * Reads every waiting event file, writes the drafts its moment calls for and moves it to events/done/.
 * With draft false (the Owner has the flow off) only opt-outs are handled; other files wait.
 */
export async function scanEvents(o: {
  repoRoot: string;
  fwHome: string;
  now?: Date;
  draft: boolean;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}): Promise<ScanReport> {
  const report: ScanReport = { processed: 0, drafts: [], skipped: [], blocked: [] };
  const flow = loadFlow(o.repoRoot, o.fwHome);
  const home = join(o.fwHome, 'flows', FLOW_KEY);
  const inbox = join(home, 'events');
  if (!flow || !existsSync(inbox)) return report;
  const { cfg } = flow;
  const now = o.now ?? new Date();
  const statePath = join(home, 'state.json');
  const state = readState(statePath);
  const factsPath = join(o.fwHome, cfg.facts.file);
  let facts: R | null = null;
  try {
    const f = existsSync(factsPath) ? readJson(factsPath) : null;
    facts = isObj(f) ? f : null;
  } catch {
    o.log?.('host-moments: facts.json is not readable JSON, so no note quotes a price or date');
  }
  const short = shortenerFor({
    fwHome: o.fwHome,
    site: o.env?.FW_FREQUENCY_URL || cfg.offer.url,
    ...(o.log ? { log: o.log } : {}),
  });
  const files = readdirSync(inbox, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => {
      let ev: R | null = null;
      try {
        const v = readJson(join(inbox, e.name));
        ev = isObj(v) ? v : null;
      } catch {
        ev = null;
      }
      return { file: e.name, ev };
    })
    .sort((a, b) => {
      const ra = FIRST[String(a.ev?.type)] ?? 2;
      const rb = FIRST[String(b.ev?.type)] ?? 2;
      return (
        ra - rb ||
        String(a.ev?.at ?? '').localeCompare(String(b.ev?.at ?? '')) ||
        a.file.localeCompare(b.file)
      );
    });
  const draftsDir = join(home, 'drafts');
  const done = join(inbox, 'done');
  const finish = (file: string, skip?: Omit<Skip, 'file'>) => {
    mkdirSync(done, { recursive: true, mode: 0o700 });
    const target = existsSync(join(done, file)) ? `${Date.now()}-${file}` : file;
    renameSync(join(inbox, file), join(done, target));
    report.processed++;
    if (skip) {
      report.skipped.push({ file, ...skip });
      o.log?.(`host-moments: ${file} (${skip.type}) made no draft: ${skip.reason}`);
    }
  };

  for (const { file, ev } of files) {
    const type = typeof ev?.type === 'string' ? ev.type : '';
    if (!o.draft && type !== 'host.opted_out') continue;
    const at = typeof ev?.at === 'string' && Number.isFinite(Date.parse(ev.at)) ? ev.at : null;
    const hostRaw = ev?.host_id ?? ev?.space_id;
    const host = typeof hostRaw === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(hostRaw) ? hostRaw : null;
    if (!ev || !KNOWN.has(type) || !at || !host) {
      finish(file, { type: type || 'unknown', reason: 'not a Frequency host event this flow reads' });
      continue;
    }
    const ref = typeof ev.ref === 'string' ? clean(ev.ref, 100) : null;
    if (type === 'host.opted_out') {
      report.blocked.push(...optOut(o.fwHome, cfg, host, ref));
      for (const f of existsSync(draftsDir) ? readdirSync(draftsDir) : []) {
        const p = join(draftsDir, f);
        const d = f.endsWith('.json') ? (readJson(p) as R) : null;
        if (d?.host_id === host && d.status === 'waiting_for_owner')
          writeAtomic(p, { ...d, held: 'opted_out' });
      }
      finish(file);
      continue;
    }
    const niche = slug(ev.niche) ?? state.niches[host] ?? null;
    if (niche) state.niches[host] = niche;
    if (type === 'event.published') {
      const url = https(ev.rsvp_url);
      const title = clean(ev.title, 80);
      const starts =
        typeof ev.starts_at === 'string' && Number.isFinite(Date.parse(ev.starts_at)) ? ev.starts_at : null;
      const id = clean(ev.event_id, 100);
      if (!url || !title || !starts || !id) {
        finish(file, { type, reason: 'the event has no title, start time, id or https RSVP link' });
        continue;
      }
      const e: Published = {
        event_id: id,
        title,
        starts_at: starts,
        town: clean(ev.town, 40),
        niche,
        rsvp_url: url.toString(),
      };
      state.published[host] = [...(state.published[host] ?? []).filter((x) => x.event_id !== id), e].slice(
        -10,
      );
    }
    if (readDnc(o.fwHome, cfg).includes(`frequency-host:${host}`)) {
      finish(file, { type, reason: 'the host is on the do-not-contact list' });
      continue;
    }
    const first = firstName(ev.first_name);
    const hi = `Hi ${first ?? 'there'},`;
    const id = `hm-${type.replace(/\W+/g, '-')}-${createHash('sha256')
      .update(`${host}|${type}|${at}|${String(ev.step ?? ev.event_id ?? '')}`)
      .digest('hex')
      .slice(0, 12)}`;
    const tag = id.toLowerCase().slice(0, 48);
    const hostLink = () => link(cfg, cfg.host_path, niche, tag, cfg.links.utm_medium);
    const upcoming = (state.published[host] ?? []).filter((x) => Date.parse(x.starts_at) > now.getTime());
    let m: Moment | string | null = null;

    if (type === 'launcher.stalled') {
      const step = clean(ev.step, 60);
      const key = `${host}|${(step ?? '').toLowerCase()}`;
      if (!step) m = 'the stall names no step';
      else if (state.stalls.includes(key)) m = 'this host already has a note for this step';
      else if (now.getTime() - Date.parse(at) > cfg.stall_max_age_hours * 3600e3)
        m = 'the stall is too old to write about now';
      else {
        state.stalls.push(key);
        m = {
          kind: 'stall_nudge',
          subject: 'Your Frequency Space',
          note: `${hi}\n\n${cfg.intro} I saw your Space setup paused at the ${step} step.\n\nWant me to set it up with you on a 10 minute call? Reply with a time that works. Or pick up where you left off: ${hostLink()}`,
        };
      }
    } else if (type === 'space.published') {
      const detail = clean(ev.detail, 80);
      const due = new Date(Date.parse(at) + cfg.thank_you_due_hours * 3600e3);
      const e = upcoming.find((x) => !state.kitted.includes(x.event_id));
      if (state.thanked.includes(host)) m = 'this host was already thanked for publishing';
      else {
        state.thanked.push(host);
        if (e) state.kitted.push(e.event_id);
        m = {
          kind: 'thank_you',
          subject: detail ? `Thank you for publishing ${detail}` : 'Thank you for publishing your Space',
          note: `${hi}\n\n${cfg.intro} Thank you for publishing ${detail ?? 'your Space'}. I'm really glad it's here.${e ? `\n\nI put together a share kit for ${e.title} below. Your own people RSVPing is the best start a first event can have.` : '\n\nWhen your first event is up, I will send you a share kit for it.'}`,
          ...(e ? { kit: shareKit(cfg, e, tag) } : {}),
          name: `${first ?? 'New host'}, thank you due ${when(due.toISOString(), cfg.timezone, true)}`,
          due_at: due.toISOString(),
        };
      }
    } else if (type === 'event.published') {
      const e = upcoming.find((x) => x.event_id === state.published[host]?.at(-1)?.event_id);
      if (!e || !state.thanked.includes(host) || state.kitted.includes(e.event_id)) m = null;
      else {
        state.kitted.push(e.event_id);
        m = {
          kind: 'share_kit',
          subject: `A share kit for ${e.title}`,
          note: `${hi}\n\nYour event ${e.title} is up. Here's a share kit, ready to copy. Your own people RSVPing is the best start an event can have.`,
          kit: shareKit(cfg, e, tag),
        };
      }
    } else if (type === 'event.filled') {
      const title = clean(ev.event_title, 80) ?? 'your event';
      m = {
        kind: 'referral_ask',
        subject: `${title} filled up`,
        note: `${hi}\n\nCongrats on filling ${title}! Who else around you should be hosting on Frequency?\n\nIf someone comes to mind, here's a short intro you can forward to them yourself:\n\n"Hey! I've been hosting on Frequency, a free way for neighbors to find or start local, in-person Circles around what they love. I think you'd be great at it. Here's where to start: ${hostLink()}"`,
      };
    } else if (type === 'event.rsvps_8') {
      const rsvps = count(ev.rsvps);
      const price = fact(facts, cfg.facts.founding_price, cfg.timezone);
      const ends = fact(facts, cfg.facts.founding_ends, cfg.timezone);
      const title = clean(ev.event_title, 80) ?? 'your event';
      if (!price || !ends) m = 'the facts sheet has no Founding Year price or end date';
      else if (rsvps === null) m = 'the event gives no RSVP count';
      else
        m = {
          kind: 'value_moment',
          subject: `${rsvps} RSVPs for ${title}`,
          note: `${hi}\n\n${rsvps} people have RSVPd to ${title}. That's a real Circle forming.\n\nFounding Year hosts lock in ${price}, open until ${ends}. Want me to hold a spot for you? ${hostLink()}`,
        };
    } else if (type === 'meter.80') {
      const [used, limit, meter] = [count(ev.used), count(ev.limit), clean(ev.meter, 30)];
      const plan = fact(facts, cfg.facts.plan_price, cfg.timezone);
      if (used === null || limit === null || !meter) m = 'the meter event has no meter, used and limit';
      else
        m = {
          kind: 'limit_note',
          subject: `Your ${meter} on Frequency`,
          note: `${hi}\n\nA quick heads up: your Space has used ${used} of its ${limit} ${meter}. ${plan ? `If you want more room, the paid plan is ${plan}.` : 'If you want more room, reply and I will walk you through the options.'}`,
        };
    }

    if (m === null) {
      finish(file);
      continue;
    }
    if (typeof m === 'string') {
      finish(file, { type, reason: m });
      continue;
    }
    const path = join(draftsDir, `${id}.json`);
    if (!existsSync(path)) {
      const note = await short.shorten(noDashes(m.note), m.subject);
      const kit = m.kit ? await short.shorten(noDashes(m.kit), m.subject) : null;
      const body = `${note}\n\n${cfg.sign_off}\n\n${cfg.opt_out}${kit ? `\n\n${kit}` : ''}`;
      writeAtomic(path, {
        flow: FLOW_KEY,
        id,
        kind: m.kind,
        fire_id: null,
        lead_id: `frequency-host:${host}`,
        host_id: host,
        space_id: typeof ev.space_id === 'string' ? ev.space_id : null,
        channel: cfg.send_via,
        subject: noDashes(m.subject),
        body,
        tag,
        ...(ref ? { ref } : {}),
        name: m.name ?? first ?? 'A host',
        ...(m.due_at ? { due_at: m.due_at } : {}),
        event_file: file,
        status: 'waiting_for_owner',
        created_at: now.toISOString(),
      });
      report.drafts.push({ id, kind: m.kind });
    }
    finish(file);
  }
  if (report.processed) writeAtomic(statePath, state);
  return report;
}
