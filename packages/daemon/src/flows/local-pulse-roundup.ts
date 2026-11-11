// FW-C-107: the local pulse roundup. From the in-area upcoming events it drafts a members email, an
// Instagram caption, one post per local group that allows promotion and was not posted in the last week,
// and a one-line heads-up per host featured. Every draft waits for the Owner, who sends or posts it by
// hand; a draft the Owner edited or sent is never overwritten by a later run.
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  DAY,
  dir,
  FLOW_KEY,
  type Group,
  type GroupStatus,
  inArea,
  isObj,
  loadConfig,
  type PulseConfig,
  pullUpcoming,
  readJson,
  readUpcoming,
  slug,
  type UpcomingEvent,
} from './local-pulse.ts';
import { writeJsonAtomic } from './neighborhood-admin.ts';
import { noDashes, shortenerFor } from './short-links.ts';

const TZ = 'America/Los_Angeles';
const SIGN_OFF = 'Daniel Tyack\nFounder\nfrequencylocal.com';
const WHO =
  "I'm Daniel, founder of Frequency, a free way for neighbors to find or start local, in-person Circles around what they love.";

const when = (iso: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
    .format(new Date(iso))
    .replace(/ /g, ' ');

/** The event's link, tagged so Frequency can trace an RSVP back to the draft (utm_content niche.tag). */
export function eventLink(e: UpcomingEvent, medium: string, tag: string): string {
  const u = new URL(e.rsvp_url);
  u.searchParams.set('utm_source', 'flowweb');
  u.searchParams.set('utm_medium', medium);
  u.searchParams.set('utm_campaign', FLOW_KEY);
  u.searchParams.set('utm_content', `${slug(e.niche ?? 'event')}.${tag}`);
  return u.toString();
}

const eventLines = (events: UpcomingEvent[], medium: string, tag: string) =>
  events.map((e) => `${e.title}\n${e.town}, ${when(e.starts_at)}\n${eventLink(e, medium, tag)}`).join('\n\n');

const townList = (events: UpcomingEvent[]) => {
  const towns = [...new Set(events.map((e) => e.town))];
  return towns.length < 2 ? (towns[0] ?? '') : `${towns.slice(0, -1).join(', ')} and ${towns.at(-1)}`;
};

interface DraftOut {
  id: string;
  kind: 'roundup_email' | 'instagram' | 'group_post' | 'heads_up';
  channel: string;
  lead_id: string;
  subject: string | null;
  body: string;
  held: string;
  extra?: Record<string, unknown>;
}

/** The latest time a group was posted: its config date or a group draft the Owner marked sent. */
function lastPosted(fwHome: string, g: Group): number {
  let t = Date.parse(g.last_posted_at ?? '');
  const d = join(dir(fwHome), 'drafts');
  if (existsSync(d))
    for (const f of readdirSync(d)) {
      const doc = readJson(join(d, f));
      if (isObj(doc) && doc.lead_id === `group:${slug(g.name)}` && typeof doc.sent_at === 'string') {
        const s = Date.parse(doc.sent_at);
        if (!(s <= t)) t = s;
      }
    }
  return t;
}

/** The roundup's drafts for these events, and what became of each group. Pure but for reading drafts. */
export function draftRoundup(
  cfg: PulseConfig,
  events: UpcomingEvent[],
  fwHome: string,
  now: Date,
): { drafts: DraftOut[]; groups: GroupStatus[] } {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  const id = (s: string) => `lp-${day}-${s}`.slice(0, 100);
  const hand = (where: string) => `send_by_hand: ${where} is sent by the Owner by hand.`;
  const drafts: DraftOut[] = [];
  const groups: GroupStatus[] = [];
  if (events.length > 0) {
    const where = townList(events);
    drafts.push({
      id: id('email'),
      kind: 'roundup_email',
      channel: 'members_email',
      lead_id: 'template:members-roundup',
      subject: `Coming up near you in ${where}`,
      body: [
        'Hi neighbor,',
        "Here is what's coming up at local Circles near you over the next two weeks. Every one is open to join.",
        eventLines(events, 'email', id('email')),
        'If one catches your eye, RSVP and come say hi. I hope to see you there.',
        SIGN_OFF,
        "P.S. Rather not get these roundups? Reply stop and I'll take you off the list the same day.",
      ].join('\n\n'),
      held: hand('The members roundup'),
    });
    drafts.push({
      id: id('instagram'),
      kind: 'instagram',
      channel: 'instagram',
      lead_id: 'template:instagram',
      subject: `Instagram: coming up in ${where}`,
      body: [
        'Coming up near you, hosted by your neighbors on Frequency.',
        eventLines(events, 'instagram', id('instagram')),
        'Find or start a Circle at frequencylocal.com',
      ].join('\n\n'),
      held: hand('Instagram'),
    });
    const cooldown = (cfg.group_cooldown_days ?? 7) * DAY;
    for (const g of cfg.groups) {
      if (!isObj(g) || typeof g.name !== 'string') continue;
      const url = typeof g.url === 'string' ? g.url : '';
      if (g.allows_promo !== true) {
        groups.push({ name: g.name, url, status: 'no_promo' });
        continue;
      }
      if (now.getTime() - lastPosted(fwHome, g) < cooldown) {
        groups.push({ name: g.name, url, status: 'posted_recently' });
        continue;
      }
      groups.push({ name: g.name, url, status: 'drafted' });
      const gid = id(`group-${slug(g.name)}`);
      drafts.push({
        id: gid,
        kind: 'group_post',
        channel: 'local_group',
        lead_id: `group:${slug(g.name)}`,
        subject: `Post for ${g.name}`,
        body: [
          'Hi neighbors,',
          `${WHO} Here are a few local events coming up that anyone can join.`,
          eventLines(events, 'group', gid),
          'Happy to answer any questions here.',
        ].join('\n\n'),
        held: hand(`A post in ${g.name}`),
        extra: { group_url: url },
      });
    }
    const byHost = new Map<string, UpcomingEvent[]>();
    for (const e of events)
      byHost.set(e.host_id ?? e.event_id, [...(byHost.get(e.host_id ?? e.event_id) ?? []), e]);
    for (const [host, mine] of byHost) {
      const hid = id(`heads-${slug(host)}`);
      const first = mine[0] as UpcomingEvent;
      const titles = mine.map((e) => e.title).join(' and ');
      drafts.push({
        id: hid,
        kind: 'heads_up',
        channel: 'heads_up',
        lead_id: `host:${host}`,
        subject: `Heads up: ${titles} is in this week's roundup`,
        body: `Hi${first.first_name ? ` ${first.first_name}` : ''}, quick heads up: ${titles} is in this week's Frequency roundup for ${first.town}, so more neighbors may find it. Here is the link if you'd like to share it: ${eventLink(first, 'one-to-one', hid)}`,
        held: hand('A heads-up to a host'),
        extra: { event_ids: mine.map((e) => e.event_id) },
      });
    }
  }
  return { drafts, groups };
}

/** Pulls, then drafts the roundup into the flow's drafts store. A draft the Owner touched is kept. */
export async function runRoundup(o: {
  repoRoot: string;
  fwHome: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  fireId?: string;
  log?: (line: string) => void;
}) {
  const now = o.now ?? new Date();
  const cfg = loadConfig(o.repoRoot, o.fwHome);
  if (!cfg) throw new Error(`the ${FLOW_KEY} flow is not in this repo`);
  const pull = await pullUpcoming({ cfg, fwHome: o.fwHome, ...(o.env ? { env: o.env } : {}), now });
  if (!pull.ok) o.log?.(`${FLOW_KEY}: pull failed, using the last good events: ${pull.error}`);
  const events = inArea(cfg, readUpcoming(o.fwHome).events, now);
  const { drafts, groups } = draftRoundup(cfg, events, o.fwHome, now);
  const out = join(dir(o.fwHome), 'drafts');
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const short = shortenerFor({
    fwHome: o.fwHome,
    site: o.env?.FW_FREQUENCY_URL || cfg.offer.url,
    ...(o.log ? { log: o.log } : {}),
  });
  let written = 0;
  for (const d of drafts) {
    const path = join(out, `${d.id}.json`);
    const old = readJson(path);
    if (isObj(old) && (old.status !== 'waiting_for_owner' || typeof old.edited_at === 'string')) continue;
    writeJsonAtomic(path, {
      flow: FLOW_KEY,
      id: d.id,
      fire_id: o.fireId ?? null,
      kind: d.kind,
      lead_id: d.lead_id,
      channel: d.channel,
      subject: d.subject && noDashes(d.subject),
      body: noDashes(await short.shorten(d.body, d.subject ?? d.id)),
      tag: d.id,
      status: 'waiting_for_owner',
      held: d.held,
      ...(d.extra ?? {}),
      created_at: now.toISOString(),
    });
    written++;
  }
  const result = { at: now.toISOString(), pull, events: events.length, drafts: written, groups };
  writeJsonAtomic(join(dir(o.fwHome), 'run.json'), result);
  return result;
}
