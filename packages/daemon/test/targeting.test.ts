// FW-C-156: the Owner's targeting edit writes only the flow it names, and refuses what a draft must not quote.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { loadProfile, mergeProfile, playbookOf } from '../src/flows/profiles.ts';
import { readTargeting, saveTargeting } from '../src/flows/targeting.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const BASE = 'neighborhood-activation';
const KEY = `${BASE}--coaches-guides`;

function homeWithCopy(): { home: string; dir: string } {
  const home = mkdtempSync(join(tmpdir(), 'fw-targeting-'));
  const dir = join(home, 'copies', KEY, 'flows', BASE);
  mkdirSync(dir, { recursive: true });
  const base = JSON.parse(readFileSync(join(ROOT, 'flows', BASE, 'config.json'), 'utf8'));
  const cfg = mergeProfile(base, loadProfile(ROOT, BASE, 'coaches-guides')?.config ?? {});
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg));
  return { home, dir };
}

test('a copy reads its own playbook and the base flow reads none', () => {
  const { home } = homeWithCopy();
  const t = readTargeting(ROOT, home, KEY);
  expect(t?.has_playbook).toBe(true);
  expect(t?.door).toBe('/for/coaches-and-healers');
  expect(t?.niches[0]?.angles[0]?.line.length).toBeGreaterThan(10);
  expect(readTargeting(ROOT, home, BASE)?.has_playbook).toBe(false);
});

test('a save changes the lines it names, keeps the rest, and the cycle reads it', () => {
  const { home, dir } = homeWithCopy();
  const was = readTargeting(ROOT, home, KEY);
  const out = saveTargeting(ROOT, home, KEY, {
    playbook: { seek: '  Guides who host weekly.  ' },
    link_line: 'Have a look:',
  });
  expect(out.summary).toContain('seek');
  expect(out.targeting.playbook.seek).toBe('Guides who host weekly.');
  expect(out.targeting.playbook.note).toBe(was?.playbook.note);
  expect(playbookOf(dir)?.seek).toBe('Guides who host weekly.');
  expect(existsSync(join(home, 'flows', BASE, 'config.json'))).toBe(false);
  expect(saveTargeting(ROOT, home, KEY, { link_line: 'Have a look:' }).summary).toContain('Nothing changed');
});

test('a new angle gets a key of its own and an edited one keeps its key', () => {
  const { home } = homeWithCopy();
  const n = readTargeting(ROOT, home, KEY)?.niches[0];
  const first = n?.angles[0]?.key ?? '';
  const out = saveTargeting(ROOT, home, KEY, {
    niches: {
      [n?.key ?? '']: { angles: [{ key: first, line: 'One.' }, 'Two.', { key: first, line: 'Three.' }] },
    },
  });
  const keys = out.targeting.niches[0]?.angles.map((a) => a.key) ?? [];
  expect(keys[0]).toBe(first);
  expect(new Set(keys).size).toBe(3);
});

test('a save is refused for a dash, an unknown field, a lost seek line and an over-long line', () => {
  const { home, dir } = homeWithCopy();
  const before = readFileSync(join(dir, 'config.json'), 'utf8');
  for (const body of [
    { playbook: { note: 'Warm — and short.' } },
    { link_line: 'See it – here:' },
    { sign_off: 'x' },
    { playbook: { seek: '' } },
    { playbook: { where: 'x'.repeat(1201) } },
    { niches: { nobody: { angles: ['x'] } } },
  ])
    expect(() => saveTargeting(ROOT, home, KEY, body)).toThrow();
  expect(readFileSync(join(dir, 'config.json'), 'utf8')).toBe(before);
});
