// FW-C-050: the Owner edits a draft's subject and text; once it is in the outbox it cannot change.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '@fw/eventlog';
import { afterEach, expect, test } from 'vitest';
import { ensureFwHome, REPO_ROOT } from '../src/daemon.ts';
import { approveDraft, editDraft, listDrafts, MAX_DRAFT_FIELD } from '../src/overseer/drafts.ts';
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

test('an edit changes subject and body, keeps the status and stamps edited_at', () => {
  const t = setup('copilot');
  t.put('a');
  const d = editDraft({ ...t.o, id: 'a', subject: 'New subject', body: 'New body' });
  expect(d).toMatchObject({ id: 'a', subject: 'New subject', body: 'New body', status: 'waiting_for_owner' });
  expect(d.edited_at).toBeTruthy();
  expect(listDrafts(REPO_ROOT, t.o.fwHome, KEY)[0]).toMatchObject({
    subject: 'New subject',
    body: 'New body',
  });
  // Only the body: the subject stays.
  expect(editDraft({ ...t.o, id: 'a', body: 'Body two' }).subject).toBe('New subject');
});

test('bad edits are refused and change nothing', () => {
  const t = setup('copilot');
  t.put('a');
  for (const bad of [
    {},
    { body: '' },
    { body: '   ' },
    { subject: 7 },
    { body: 'x'.repeat(MAX_DRAFT_FIELD + 1) },
  ])
    expect(() => editDraft({ ...t.o, id: 'a', ...bad })).toThrow();
  expect(listDrafts(REPO_ROOT, t.o.fwHome, KEY)[0]).toMatchObject({ subject: 'Hi', body: 'Hello from a' });
  expect(() => editDraft({ ...t.o, id: 'nope', body: 'x' })).toThrow(/no draft/);
});

test('approving hands off the edited text, and a handed-off draft cannot be edited', () => {
  const t = setup('copilot');
  t.put('a');
  editDraft({ ...t.o, id: 'a', body: 'Edited before approval' });
  approveDraft({ ...t.o, id: 'a' });
  const file = join(t.o.fwHome, 'outbox', KEY, 'a.json');
  const sent = readFileSync(file, 'utf8');
  expect(sent).toContain('Edited before approval');
  expect(() => editDraft({ ...t.o, id: 'a', body: 'Too late' })).toThrow(/handed_off/);
  expect(readFileSync(file, 'utf8')).toBe(sent);
  expect(t.outbox()).toEqual(['a.json']);
  expect(t.queued('a')).toBe(1);
});
