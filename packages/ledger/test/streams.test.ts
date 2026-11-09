// WS-P1-003: the stream object model. Budget required, tier above L2 needs a recorded approval,
// accepted streams stored with one stream.created event each.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { addStream, listStreams } from '../src/streams/streams.ts';
import { fileStore, REPO_ROOT, row, syncInto, tempDir, writeRows } from './helpers.ts';

const dir = tempDir();
const store = fileStore(dir);
const projectId = syncInto(store, writeRows(join(dir, 'rows'), [row('FW-C-940')])).project_id!;
const w = store.writer!;

function def(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const d = JSON.parse(
    readFileSync(join(REPO_ROOT, 'contracts-core/examples/24-stream-definition.json'), 'utf8'),
  );
  delete d.tier_caps;
  return { ...d, id, key: id.slice(4), project_id: projectId, version: 1, ...extra };
}

const streamCount = () => w.get<{ n: number }>('SELECT count(*) AS n FROM streams')!.n;
const created = (id: string) =>
  w.get<{ n: number }>("SELECT count(*) AS n FROM events WHERE type = 'stream.created' AND stream_id = ?", [
    id,
  ])!.n;

describe('addStream', () => {
  test.each([
    ['no budget', { budget: undefined }, /without a budget/],
    ['empty caps', { budget: { caps: {}, period: 'day' } }, /no caps/],
  ])('refuses a stream with %s and writes nothing', (_name, extra, reason) => {
    const before = streamCount();
    expect(() => addStream(w, def('stm_nobudget1', extra))).toThrow(reason);
    expect(streamCount()).toBe(before);
    expect(created('stm_nobudget1')).toBe(0);
  });

  test('refuses an invalid definition with the contract errors', () => {
    expect(() => addStream(w, def('stm_badtrig01', { trigger: { type: 'never' } }))).toThrow(
      expect.objectContaining({ code: 'INVALID_DEFINITION' }),
    );
  });

  test.each([
    ['no approval id', undefined],
    ['an unrecorded approval id', 'apr_notrecorded1'],
  ])('refuses tier L3 with %s (policy code APPROVAL_REQUIRED)', (_name, approvalId) => {
    const before = streamCount();
    expect(() =>
      addStream(w, def('stm_tierl3001', { default_tier: 'L3' }), approvalId ? { approvalId } : {}),
    ).toThrow(
      expect.objectContaining({ code: 'APPROVAL_REQUIRED', message: expect.stringMatching(/approval/) }),
    );
    expect(streamCount()).toBe(before);
    expect(created('stm_tierl3001')).toBe(0);
  });

  test('stores an L2 stream with its hash, budget and one stream.created event; lists it', () => {
    const r = addStream(w, def('stm_accepted01'));
    expect(r.stream).toMatchObject({
      project_id: projectId,
      key: 'accepted01',
      default_tier: 'L2',
      status: 'active',
    });
    expect(r.stream.definition_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.stream.budget).toEqual({ caps: { max_usd: 8 }, period: 'day' });
    expect(created('stm_accepted01')).toBe(1);
    expect(listStreams(w).map((s) => s.id)).toContain('stm_accepted01');
    expect(listStreams(w)).toHaveLength(streamCount());
  });

  test('refuses a second stream with the same id or key', () => {
    expect(() => addStream(w, def('stm_accepted01'))).toThrow(
      expect.objectContaining({ code: 'ALREADY_EXISTS' }),
    );
    expect(() => addStream(w, def('stm_other0001', { key: 'accepted01' }))).toThrow(/already exists/);
    expect(created('stm_accepted01')).toBe(1);
  });

  test('refuses a stream for a project not in the ledger', () => {
    expect(() => addStream(w, def('stm_noproj001', { project_id: 'prj_missing1' }))).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });
});
