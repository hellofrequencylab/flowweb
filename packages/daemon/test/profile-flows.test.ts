// FW-C-152: the shipped profiles (three main, five more that ship off) are well formed: each has a full playbook, its own page, niches with
// angles and a starter hunt the flow accepts, and patches only keys the base config has.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { funnelLink, type Hunt, newHunt } from '../src/flows/hunts.ts';
import type { FlowConfig } from '../src/flows/neighborhood-activation.ts';
import { listProfiles, mergeProfile, PLAYBOOK_KEYS } from '../src/flows/profiles.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BASE = 'neighborhood-activation';
const baseCfg = () => JSON.parse(readFileSync(join(ROOT, 'flows', BASE, 'config.json'), 'utf8'));
const DOORS: Record<string, string> = {
  'clubs-groups': '/for/clubs-and-groups',
  'coaches-guides': '/for/coaches-and-healers',
  'local-businesses': '/for/local-businesses',
  networks: '/for/networks',
  nonprofits: '/for/nonprofits',
  spiritual: '/for/spiritual-community',
  studios: '/for/studios',
  'venues-hosts': '/for/venues',
};

test('every profile ships, each with a playbook, a door, niches and a starter hunt that saves', () => {
  const all = listProfiles(ROOT, BASE);
  expect(all.map((p) => p.slug)).toEqual(Object.keys(DOORS).sort());
  for (const p of all) {
    expect(JSON.stringify(p)).not.toMatch(/[–—]|Midnight/);
    expect(p.name).toMatch(/^Frequency /);
    const cfg = mergeProfile(baseCfg(), p.config) as unknown as FlowConfig & {
      hunts: { playbook: Record<string, string>; sign_off: string; link_line: string };
    };
    for (const k of PLAYBOOK_KEYS) expect(cfg.hunts.playbook[k]?.length).toBeGreaterThan(40);
    expect(cfg.hunts.link_line.endsWith(':')).toBe(true);
    expect(cfg.hunts.sign_off).toBe(baseCfg().hunts.sign_off);
    expect(cfg.offer.url).toBe(baseCfg().offer.url);
    expect(cfg.funnels.host.path).toBe(DOORS[p.slug]);
    expect(cfg.dm_door?.path).toBe(DOORS[p.slug]);
    expect(cfg.niches?.length).toBeGreaterThanOrEqual(2);
    for (const n of cfg.niches ?? []) expect(n.angles.length).toBeGreaterThanOrEqual(2);
    expect(p.hunts.length).toBeGreaterThanOrEqual(1);
    for (const h of p.hunts) expect(newHunt(cfg, h, new Date()).region).toBe('north-county-sd');
    for (const k of Object.keys(p.config)) expect(Object.hasOwn(baseCfg(), k)).toBe(true);
  }
});

test('a series host in the venues profile is sent to the event hosts page', () => {
  const p = listProfiles(ROOT, BASE).find((x) => x.slug === 'venues-hosts');
  const cfg = mergeProfile(baseCfg(), p?.config ?? {}) as unknown as FlowConfig;
  const h = { ...newHunt(cfg, p?.hunts[0] ?? {}, new Date()), id: 'hnt_1' } as Hunt;
  expect(funnelLink(cfg, h, { niche: 'venue' })).toContain('/for/venues?');
  expect(funnelLink(cfg, h, { niche: 'series-host' })).toContain('/for/event-hosts?');
});
