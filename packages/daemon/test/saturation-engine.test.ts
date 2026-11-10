import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Hunt } from '../src/flows/hunts.ts';
import { audienceOf, brief } from '../src/overseer/cycle.ts';
import { mergedInto } from '../src/overseer/index.ts';

const repoRoot = join(import.meta.dirname, '../../..');
const hunt = {
  id: 'hnt_1',
  name: 'North County',
  looking_for: 'events',
  region: 'north-county-sd',
  areas: [],
  links: [],
  every_days: 1,
  max_sends: 5,
  build: false,
  enabled: true,
} as unknown as Hunt;

describe('FW-C-096 audience', () => {
  it('reads hunts.audience from a cycle folder and is empty without one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aud-'));
    expect(audienceOf(dir)).toEqual({ focus: [], steer_away: [] });
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ hunts: { audience: { focus: ['yoga', 3], steer_away: ['seniors'] } } }),
    );
    expect(audienceOf(dir)).toEqual({ focus: ['yoga'], steer_away: ['seniors'] });
  });

  it('puts the audience only in a hunt brief', () => {
    const a = { focus: ['ecstatic dance'], steer_away: ['programs mainly for seniors'] };
    const withHunt = brief('k', {}, [hunt], ['host'], false, a);
    expect(withHunt).toContain('ecstatic dance');
    expect(withHunt).toContain('Skip events that are mainly these');
    expect(brief('k', {}, [], ['host'], false, a)).not.toContain('ecstatic dance');
  });

  it('knows the old local flow was merged into the engine', () => {
    expect(mergedInto(repoRoot, 'local-saturation')).toBe('neighborhood-activation');
    expect(mergedInto(repoRoot, 'neighborhood-activation')).toBeNull();
    expect(mergedInto(repoRoot, 'no-such-flow')).toBeNull();
  });
});
