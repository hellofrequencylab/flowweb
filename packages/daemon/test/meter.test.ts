// FW-C-122: the meter records each turn once and divides the window's whole spend by each outcome.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { meterTurn, meterView, readTurns } from '../src/overseer/meter.ts';

const cost = (i: number, c: number, o: number, usd: number) => ({
  input_tokens: i,
  cached_tokens: c,
  output_tokens: o,
  usd,
});

test('turns are kept per flow and a torn line is skipped', () => {
  const home = mkdtempSync(join(tmpdir(), 'meter-'));
  meterTurn(home, { flow: 'f', step: 'cycle', item: 'fire1', cost: cost(100, 300, 50, 0.01), drafts: ['a'] });
  writeFileSync(join(home, 'meter', 'turns.jsonl'), '{"torn', { flag: 'a' });
  expect(readTurns(home)).toHaveLength(1);
});

test('per outcome uses the whole spend; per model splits by model; a copy reads its own drafts', () => {
  const home = mkdtempSync(join(tmpdir(), 'meter-'));
  const flow = 'f--two';
  const drafts = join(home, 'copies', flow, 'flows', 'f', 'drafts');
  mkdirSync(drafts, { recursive: true });
  writeFileSync(join(drafts, 'a.json'), JSON.stringify({ id: 'a', tag: 'a', replied_at: 'x' }));
  writeFileSync(join(drafts, 'b.json'), JSON.stringify({ id: 'b', tag: 'b' }));
  writeFileSync(
    join(home, 'copies', flow, 'flows', 'f', 'outcomes.json'),
    JSON.stringify({ outcomes: [{ content: 'a', members: 1, hosts: 1 }] }),
  );
  const small = { vendor: 'v', model: 'small' };
  meterTurn(home, {
    flow,
    step: 'cycle',
    item: '1',
    cost: cost(100, 300, 0, 0.01),
    adapter: small,
    drafts: ['a'],
  });
  meterTurn(home, {
    flow,
    step: 'cycle',
    item: '2',
    cost: cost(100, 0, 0, 0.03),
    adapter: { vendor: 'v', model: 'big' },
    drafts: ['b'],
  });
  const v = meterView(home, { flow, days: 30 });
  expect(v.outcomes).toEqual({ drafted: 2, sent: 1, replied: 1, signed_up: 2 });
  expect(v.per_outcome.replied).toEqual({ tokens: 500, usd: 0.04 });
  expect(v.cache_share).toBeCloseTo(0.6);
  expect(v.packet_p95).toBe(400);
  const big = v.by_model.find((m) => m.model === 'big');
  expect(big?.usd_per_outcome.replied).toBeNull();
  expect(v.by_model.find((m) => m.model === 'small')?.usd_per_outcome.replied).toBeCloseTo(0.01);
  expect(meterView(home, { flow: 'other', days: 30 }).per_outcome.drafted).toBeNull();
});
