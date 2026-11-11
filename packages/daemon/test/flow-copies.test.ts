// FW-C-121: a copy of a flow resolves to its base flow and its own home; its stream and config are its own.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { copyConfig, copyKey, copyStream, flowRef } from '../src/overseer/copies.ts';

test('a shipped key keeps its home; a copy key runs its base under copies/<key>', () => {
  expect(flowRef('/h', 'local-saturation')).toEqual({ base: 'local-saturation', home: '/h', copy: false });
  expect(flowRef('/h', 'local-saturation--austin')).toEqual({
    base: 'local-saturation',
    home: join('/h', 'copies', 'local-saturation--austin'),
    copy: true,
  });
});

test('slugs are lowercase words with single dashes, and the key fits a stream key', () => {
  expect(copyKey('paid-ads', 'north-county')).toEqual({ key: 'paid-ads--north-county' });
  for (const bad of ['Austin', 'a b', 'a--b', '-a', 'a-', '', 'x'.repeat(40)])
    expect('error' in copyKey('paid-ads', bad)).toBe(true);
});

test("a copy's stream has its own key and a valid id that differs from the base's", () => {
  const s = copyStream({ id: 'stm_base1', key: 'paid-ads', name: 'Ads' }, 'paid-ads--2');
  expect(s.key).toBe('paid-ads--2');
  expect(s.name).toBe('Ads');
  expect(String(s.id)).toMatch(/^stm_[0-9A-Za-z]{4,40}$/);
  expect(s.id).not.toBe(copyStream({ id: 'stm_base1' }, 'paid-ads--3').id);
});

test('config patches only keys the base has, over the override when there is one', () => {
  const repo = mkdtempSync(join(tmpdir(), 'copies-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'copies-home-'));
  mkdirSync(join(repo, 'flows', 'f'), { recursive: true });
  writeFileSync(join(repo, 'flows', 'f', 'config.json'), JSON.stringify({ city: 'SD', niche: 'yoga' }));
  expect(copyConfig(repo, home, 'f', { city: 'Austin' })).toEqual({
    config: { city: 'Austin', niche: 'yoga' },
  });
  expect('error' in copyConfig(repo, home, 'f', { other: 1 })).toBe(true);
  expect('error' in copyConfig(repo, home, 'f', ['x'])).toBe(true);
  mkdirSync(join(home, 'flows', 'f'), { recursive: true });
  writeFileSync(join(home, 'flows', 'f', 'config.json'), JSON.stringify({ city: 'LA', niche: 'sound' }));
  expect(copyConfig(repo, home, 'f', undefined)).toEqual({ config: { city: 'LA', niche: 'sound' } });
});
