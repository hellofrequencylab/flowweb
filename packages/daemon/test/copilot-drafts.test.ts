// FW-C-046: at Copilot the Owner approves or rejects each cycle draft. Approving hands it off exactly
// as Autopilot does, once; a rejected, template or lead-less draft never goes out; at Draft nothing does.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '@fw/eventlog';
import { afterEach, expect, test } from 'vitest';
import { ensureFwHome, REPO_ROOT } from '../src/daemon.ts';
import { approveDraft, listDrafts, rejectDraft } from '../src/overseer/drafts.ts';
import { setDial, setFlowEnabled } from '../src/overseer/index.ts';
import { tempHome } from './api-fixtures.ts';

const KEY = 'neighborhood-activation';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function setup(stop: 'draft' | 'copilot') {
  const h = tempHome();
  cleanups.push(h.cleanup);
  ensureFwHome(h.path);
  const store = openStore({ path: join(h.path, 'db', 'fw.sqlite'), lockPath: join(h.path, 'fwd.lock') });
  cleanups.unshift(() => store.close());
  const w = store.writer!;
  setFlowEnabled(w, REPO_ROOT, KEY, true);
  setDial(w, REPO_ROOT, h.path, KEY, stop);
  const dir = join(h.path, 'flows', KEY, 'drafts');
  mkdirSync(dir, { recursive: true });
  const put = (id: string, extra: Record<string, unknown> = {}, at = '2026-11-10T00:00:00.000Z') =>
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({
        flow: KEY,
        id,
        fire_id: 'f1',
        lead_id: `lead-${id}`,
        channel: 'founder_email',
        subject: 'Hi',
        body: `Hello from ${id}`,
        status: 'waiting_for_owner',
        created_at: at,
        ...extra,
      }),
    );
  const o = { writer: w, repoRoot: REPO_ROOT, fwHome: h.path, flow: KEY };
  const queued = (id: string) =>
    w.all("SELECT 1 FROM events WHERE type = 'notification.queued' AND idempotency_key = ?", [
      `flow_handoff:${KEY}:${id}`,
    ]).length;
  const outbox = () => {
    const d = join(h.path, 'outbox', KEY);
    return existsSync(d) ? readdirSync(d) : [];
  };
  return { o, put, queued, outbox };
}

test('drafts list newest first, and approving at Copilot hands one off exactly once', () => {
  const t = setup('copilot');
  t.put('old', {}, '2026-11-09T00:00:00.000Z');
  t.put('new', {}, '2026-11-10T00:00:00.000Z');
  expect(listDrafts(REPO_ROOT, t.o.fwHome, KEY).map((d) => d.id)).toEqual(['new', 'old']);

  expect(approveDraft({ ...t.o, id: 'new' })).toMatchObject({ id: 'new', status: 'handed_off' });
  expect(approveDraft({ ...t.o, id: 'new' }).status).toBe('handed_off');
  expect(t.outbox()).toEqual(['new.json']);
  expect(t.queued('new')).toBe(1);
  expect(listDrafts(REPO_ROOT, t.o.fwHome, KEY).find((d) => d.id === 'new')?.approved_at).toBeTruthy();
});

test('a rejected draft is never handed off, and a handed-off draft cannot be rejected', () => {
  const t = setup('copilot');
  t.put('a');
  t.put('b');
  expect(rejectDraft({ ...t.o, id: 'a' }).status).toBe('rejected');
  expect(() => approveDraft({ ...t.o, id: 'a' })).toThrow(/^rejected:/);
  approveDraft({ ...t.o, id: 'b' });
  expect(() => rejectDraft({ ...t.o, id: 'b' })).toThrow(/^handed_off:/);
  expect(t.queued('a')).toBe(0);
  expect(t.outbox()).toEqual(['b.json']);
});

test('templates, lead-less drafts and unknown channels are refused with their reason', () => {
  const t = setup('copilot');
  t.put('tpl', { lead_id: 'template:host' });
  t.put('nolead', { lead_id: null });
  t.put('chan', { channel: 'carrier_pigeon' });
  expect(() => approveDraft({ ...t.o, id: 'tpl' })).toThrow(/^template:/);
  expect(() => approveDraft({ ...t.o, id: 'nolead' })).toThrow(/^no_recipient:/);
  expect(() => approveDraft({ ...t.o, id: 'chan' })).toThrow(/^unknown_channel:/);
  expect(() => approveDraft({ ...t.o, id: '../x' })).toThrow(/draft id/);
  expect(t.outbox()).toEqual([]);
});

test('at Draft approving is refused with needs_copilot and nothing goes out', () => {
  const t = setup('draft');
  t.put('a');
  expect(() => approveDraft({ ...t.o, id: 'a' })).toThrow(/^needs_copilot:/);
  expect(t.queued('a')).toBe(0);
  expect(listDrafts(REPO_ROOT, t.o.fwHome, KEY)[0]?.status).toBe('waiting_for_owner');
});
