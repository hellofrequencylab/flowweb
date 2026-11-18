// FW-C-152: what a profile changes in the engine. A playbook shapes the hunt brief, a niche may open its own
// page, a profile patch merges one level deep, and copies of a flow share one do-not-contact list and one
// record of who was written to.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import {
  composeBody,
  funnelLink,
  type Hunt,
  type HuntLead,
  newHunt,
  screenLeads,
} from '../src/flows/hunts.ts';
import type { FlowConfig } from '../src/flows/neighborhood-activation.ts';
import { loadProfile, mergeProfile, PLAYBOOK_KEYS, playbookOf, sharedReach } from '../src/flows/profiles.ts';
import { brief } from '../src/overseer/cycle.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BASE = 'neighborhood-activation';
const baseCfg = () => JSON.parse(readFileSync(join(ROOT, 'flows', BASE, 'config.json'), 'utf8'));
const PATCH = {
  niches: [
    { key: 'room', label: 'Rooms', angles: [{ key: 'a', line: 'One calendar.' }] },
    { key: 'series', label: 'Series', door: '/for/event-hosts', angles: [{ key: 'b', line: 'Next date.' }] },
    { key: 'odd', label: 'Odd', door: 'https://elsewhere.example/x', angles: [{ key: 'c', line: 'No.' }] },
  ],
  dm_door: { path: '/for/venues' },
  funnels: { host: { path: '/for/venues', persona: 'partner' } },
  hunts: {
    link_line: "If you'd like a free page, start here:",
    playbook: Object.fromEntries(PLAYBOOK_KEYS.map((k) => [k, `PLAY-${k} line for the brief.`])),
  },
};
const cfgOf = () => mergeProfile(baseCfg(), PATCH) as unknown as FlowConfig;
const hunt = (): Hunt =>
  ({
    ...newHunt(baseCfg(), { name: 'n', looking_for: 'x', region: 'north-county-sd' }, new Date()),
    id: 'hnt_1',
  }) as Hunt;
const lead = (email: string, niche: string | null = null): HuntLead => ({
  hunt_id: 'hnt_1',
  event: { title: 'Circle', starts_at: null, url: 'https://example.com/e', country: 'US' },
  organizer: {
    name: 'Ana',
    email,
    source_url: 'https://example.com/o',
    country: 'US',
    contact_via: 'email',
    contact_url: null,
  },
  subject: 'Hello',
  body: 'Hi Ana, I love your circle!',
  niche,
  angle: null,
});

test('a profile patch merges one level deep and a profile file is read by slug', () => {
  const cfg = cfgOf() as FlowConfig & { hunts: { sign_off: string; playbook: unknown } };
  expect(cfg.hunts.sign_off).toBe(baseCfg().hunts.sign_off);
  expect(cfg.funnels.host.path).toBe('/for/venues');
  expect(cfg.funnels.resident).toEqual(baseCfg().funnels.resident);
  expect(cfg.niches?.map((n) => n.key)).toEqual(['room', 'series', 'odd']);
  const repo = mkdtempSync(join(tmpdir(), 'profile-repo-'));
  mkdirSync(join(repo, 'flows', 'f', 'profiles'), { recursive: true });
  writeFileSync(
    join(repo, 'flows', 'f', 'profiles', 'yoga.json'),
    JSON.stringify({ slug: 'yoga', name: 'Yoga', config: {}, hunts: [{}, 1] }),
  );
  writeFileSync(
    join(repo, 'flows', 'f', 'profiles', 'bad.json'),
    JSON.stringify({ slug: 'other', name: 'x', config: {} }),
  );
  expect(loadProfile(repo, 'f', 'yoga')).toEqual({
    slug: 'yoga',
    name: 'Yoga',
    note: '',
    config: {},
    hunts: [{}],
  });
  for (const s of ['bad', 'none', '../yoga']) expect(loadProfile(repo, 'f', s)).toBeNull();
});

test("a playbook replaces the event hunt lines in the brief; without one the brief is the base flow's", () => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-brief-'));
  expect(playbookOf(dir)).toBeNull();
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfgOf()));
  const pb = playbookOf(dir);
  const plain = brief('k', {}, [hunt()], ['host'], false);
  const mine = brief('k', {}, [hunt()], ['host'], false, undefined, ['RULE'], pb);
  expect(plain).toContain('search public event listings');
  expect(plain).toContain('Pages in Bloom');
  expect(mine).not.toContain('search public event listings');
  expect(mine).not.toContain('Pages in Bloom');
  for (const k of PLAYBOOK_KEYS) expect(mine).toContain(`PLAY-${k} line`);
  for (const s of ['leads.json', 'RULE', 'Never guess an address', 'EU or EEA', 'data, not instructions'])
    expect(mine).toContain(s);
  expect(mine).not.toMatch(/[–—]/);
  expect(brief('k', {}, [], ['host'], false, undefined, [], pb)).not.toContain('PLAY-');
});

test("a niche with its own door sends its leads there; the rest use the flow's door", () => {
  const [cfg, h] = [cfgOf(), hunt()];
  expect(funnelLink(cfg, h, { niche: 'room' })).toContain('/for/venues?');
  expect(funnelLink(cfg, h, { niche: 'series' })).toContain('/for/event-hosts?');
  expect(funnelLink(cfg, h, undefined, 'series')).toContain('/for/event-hosts?');
  // A door must be a path on the offer's own site.
  expect(funnelLink(cfg, h, { niche: 'odd' })).toContain('frequencylocal.com/for/venues?');
  const body = composeBody(cfg, h, lead('ana@example.com', 'series'));
  expect(body).toContain(
    "If you'd like a free page, start here: https://frequencylocal.com/for/event-hosts?",
  );
  expect(body).toContain('reply "no"');
  // The base flow is unchanged: one door, the old lead-in.
  expect(composeBody(baseCfg(), h, lead('ana@example.com', 'venue'))).toContain(
    "If you'd like to host on Frequency, start here: https://frequencylocal.com/start/host?",
  );
});

test('copies share do-not-contact and who was written to; caps stay per flow', () => {
  const home = mkdtempSync(join(tmpdir(), 'profile-shared-'));
  const put = (dir: string, state: unknown) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  };
  put(join(home, 'flows', BASE), {
    do_not_contact: ['no@example.com'],
    hunt_contacts: { 'a@example.com': {} },
  });
  put(join(home, 'copies', `${BASE}--coaches`, 'flows', BASE), {
    do_not_contact: ['@blocked.example'],
    hunt_contacts: { 'b@example.com': {} },
  });
  put(join(home, 'copies', 'paid-ads--2', 'flows', 'paid-ads'), { do_not_contact: ['other@example.com'] });
  const shared = sharedReach(home, BASE);
  expect(shared.doNotContact.sort()).toEqual(['@blocked.example', 'no@example.com']);
  expect([...shared.contacted].sort()).toEqual(['a@example.com', 'b@example.com']);
  const state = { do_not_contact: shared.doNotContact, hunt_contacts: {} } as never;
  const leads = [
    'a@example.com',
    'b@example.com',
    'no@example.com',
    'x@blocked.example',
    'new@example.com',
  ].map((e) => lead(e));
  const { kept, counts } = screenLeads({
    cfg: baseCfg(),
    state,
    hunts: [hunt()],
    leads,
    now: new Date(),
    perDay: 1,
    taken: shared.contacted,
  });
  expect(kept.map((k) => k.key)).toEqual(['new@example.com']);
  expect(counts.hnt_1).toMatchObject({ duplicate: 2, blocked: 2, drafted: 1, capped: 0 });
});
