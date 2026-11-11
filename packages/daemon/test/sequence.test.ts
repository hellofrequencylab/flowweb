// FW-C-104: the outreach sequence. Three touches at about day 0, 5 and 12; a reply or a no ends it the
// same day; a DM lead with a public email is offered email next; email touches reach the sender only
// through a batch the Owner approves, 20 a day at most.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '@fw/eventlog';
import { afterEach, expect, test } from 'vitest';
import { ensureFwHome, REPO_ROOT } from '../src/daemon.ts';
import { batchApprove, dueTouches, loadSequence } from '../src/flows/sequence.ts';
import { setDial, setFlowEnabled } from '../src/overseer/index.ts';
import { tempHome } from './api-fixtures.ts';

const KEY = 'neighborhood-activation';
const NOW = new Date('2026-11-20T17:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function setup(o: { batch?: boolean; cap?: number } = {}) {
  const h = tempHome();
  cleanups.push(h.cleanup);
  ensureFwHome(h.path);
  const store = openStore({ path: join(h.path, 'db', 'fw.sqlite'), lockPath: join(h.path, 'fwd.lock') });
  cleanups.unshift(() => store.close());
  const w = store.writer!;
  setFlowEnabled(w, REPO_ROOT, KEY, true);
  setDial(w, REPO_ROOT, h.path, KEY, 'draft');
  const flowDir = join(h.path, 'flows', KEY);
  const dir = join(flowDir, 'drafts');
  mkdirSync(dir, { recursive: true });
  if (o.batch !== undefined) {
    const cfg = JSON.parse(readFileSync(join(REPO_ROOT, 'flows', KEY, 'config.json'), 'utf8'));
    cfg.sequence = { email_batch_approval: o.batch, ...(o.cap ? { email_daily_cap: o.cap } : {}) };
    writeFileSync(join(flowDir, 'config.json'), JSON.stringify(cfg));
  }
  const put = (id: string, extra: Record<string, unknown> = {}) =>
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({
        flow: KEY,
        id,
        channel: 'frequency',
        send_via: 'email',
        to: `${id}@example.com`,
        source_url: 'https://example.com/events',
        subject: 'Hi',
        body: 'Hello. https://example.com/events If not, reply "no" and I will not write again.',
        status: 'waiting_for_owner',
        created_at: ago(30),
        ...extra,
      }),
    );
  const outbox = () => {
    const d = join(h.path, 'outbox', KEY);
    return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.json')) : [];
  };
  const approve = (ids: string[], now = NOW) =>
    batchApprove({ writer: w, repoRoot: REPO_ROOT, fwHome: h.path, flow: KEY, draftIds: ids, now });
  return { home: h.path, put, outbox, approve };
}

test('touch 2 is due about day 5, a reply closes the lead, and a fourth touch is never due', () => {
  const t = setup();
  t.put('a1', { send_via: 'social_dm', to: null, sent_at: ago(5.1) });
  t.put('b1', { sent_at: ago(5.1), replied_at: ago(0.1) });
  t.put('e1', { sent_at: ago(2) });
  for (const [i, d] of [20, 15, 8].entries())
    t.put(`c${i + 1}`, { sequence_lead: 'lead-c', sent_at: ago(d), created_at: ago(d) });
  const due = dueTouches(KEY, NOW, t.home);
  expect(due.map((d) => [d.lead, d.n, d.route])).toEqual([['a1', 2, 'social_dm']]);
  const leads = loadSequence(t.home, KEY).leads;
  expect(leads['b1@example.com']).toMatchObject({ state: 'closed', closed_reason: 'replied' });
  expect(leads['lead-c']).toMatchObject({ state: 'closed', closed_reason: 'three_touches' });
  expect(leads['lead-c']?.touches).toHaveLength(3);
  expect(leads['e1@example.com']).toMatchObject({ state: 'touch1' });
  // Day 12: touch 3 comes due, and after it nothing more.
  t.put('d1', { sequence_lead: 'lead-d', sent_at: ago(12.5), created_at: ago(13) });
  t.put('d2', { sequence_lead: 'lead-d', sent_at: ago(7.4), created_at: ago(8) });
  expect(dueTouches(KEY, NOW, t.home).find((d) => d.lead === 'lead-d')?.n).toBe(3);
  t.put('d3', { sequence_lead: 'lead-d', sent_at: ago(0.1), created_at: ago(0.2) });
  t.put('d4', { sequence_lead: 'lead-d', sent_at: ago(0.05), created_at: ago(0.1) });
  expect(
    dueTouches(KEY, new Date(NOW.getTime() + 60 * 86_400_000), t.home).some((d) => d.lead === 'lead-d'),
  ).toBe(false);
  expect(loadSequence(t.home, KEY).leads['lead-d']?.touches).toHaveLength(3);
});

test('a declined lead and a lead on do-not-contact close the same day', () => {
  const t = setup();
  t.put('x1', { sent_at: ago(6), declined_at: NOW.toISOString() });
  t.put('y1', { sent_at: ago(6) });
  writeFileSync(
    join(t.home, 'flows', KEY, 'state.json'),
    JSON.stringify({ do_not_contact: ['y1@example.com'] }),
  );
  expect(dueTouches(KEY, NOW, t.home)).toEqual([]);
  const leads = loadSequence(t.home, KEY).leads;
  expect(leads['x1@example.com']).toMatchObject({ closed_reason: 'declined', closed_at: NOW.toISOString() });
  expect(leads['y1@example.com']?.closed_reason).toBe('do_not_contact');
});

test('a DM lead with a public email is offered touch 2 by email', () => {
  const t = setup();
  t.put('a1', {
    send_via: 'social_dm',
    to: null,
    public_email: 'host@example.com',
    sequence_lead: 'lead-a',
    sent_at: ago(5.2),
  });
  t.put('b1', { send_via: 'social_dm', to: null, sequence_lead: 'lead-b', sent_at: ago(5.2) });
  expect(dueTouches(KEY, NOW, t.home).map((d) => [d.lead, d.route, d.previous_route])).toEqual([
    ['lead-a', 'email', 'social_dm'],
    ['lead-b', 'social_dm', 'social_dm'],
  ]);
});

test('a DM lead with a public email switches touch 2 to email, and the batch hands it off at Draft', () => {
  const t = setup({ batch: true });
  t.put('a1', {
    send_via: 'social_dm',
    to: null,
    public_email: 'host@example.com',
    sequence_lead: 'lead-a',
    sent_at: ago(5.2),
  });
  expect(dueTouches(KEY, NOW, t.home)).toMatchObject([
    { lead: 'lead-a', n: 2, route: 'email', previous_route: 'social_dm' },
  ]);
  t.put('a2', { to: 'host@example.com', sequence_lead: 'lead-a', created_at: ago(0) });
  const r = t.approve(['a2']);
  expect(r.handed_off).toEqual(['a2']);
  expect(t.outbox()).toEqual(['a2.json']);
  const item = JSON.parse(readFileSync(join(t.home, 'outbox', KEY, 'a2.json'), 'utf8'));
  expect(item.lead).toMatchObject({ to: 'host@example.com', send_via: 'email', sequence_touch: 2 });
  expect(loadSequence(t.home, KEY).leads['lead-a']).toMatchObject({ state: 'touch2', next_due_at: null });
  // Approving again changes nothing.
  expect(t.approve(['a2']).handed_off).toEqual(['a2']);
  expect(t.outbox()).toHaveLength(1);
});

test('a batch of 25 hands off 20 and holds 5; DMs, closed leads and fourth touches are refused', () => {
  const t = setup({ batch: true });
  const ids = Array.from({ length: 25 }, (_, i) => `e${String(i + 1).padStart(2, '0')}`);
  for (const id of ids) t.put(id);
  t.put('dm', { send_via: 'social_dm', to: null, contact_url: 'https://example.com/me' });
  t.put('b1', { sequence_lead: 'lead-b', sent_at: ago(6), replied_at: ago(1) });
  t.put('b2', { sequence_lead: 'lead-b' });
  for (const [i, d] of [20, 15, 8].entries())
    t.put(`c${i + 1}`, { sequence_lead: 'lead-c', sent_at: ago(d), created_at: ago(d) });
  t.put('c4', { sequence_lead: 'lead-c' });
  const r = t.approve(['dm', 'b2', 'c4', ...ids]);
  expect(r.handed_off).toHaveLength(20);
  expect(r.held.map((h) => h.id)).toEqual(ids.slice(20));
  expect(r.held.every((h) => h.reason.startsWith('daily_cap'))).toBe(true);
  expect(Object.fromEntries(r.refused.map((x) => [x.id, x.reason.split(':')[0]]))).toEqual({
    dm: 'not_email',
    b2: 'closed',
    c4: 'closed',
  });
  expect(t.outbox()).toHaveLength(20);
  // The cap is a day: the held five stay held until it rolls over.
  expect(t.approve(ids.slice(20)).held).toHaveLength(5);
  expect(t.approve(ids.slice(20), new Date(NOW.getTime() + 86_400_000 + 1000)).handed_off).toHaveLength(5);
});

test('without email_batch_approval, a flow at Draft hands nothing off', () => {
  const t = setup({ batch: false });
  t.put('e1');
  const r = t.approve(['e1']);
  expect(r.handed_off).toEqual([]);
  expect(r.held[0]?.reason).toMatch(/^needs_copilot/);
  expect(t.outbox()).toEqual([]);
});

test('a configured cap lower than 20 wins; a higher one is held at 20', () => {
  const low = setup({ batch: true, cap: 2 });
  for (const id of ['e1', 'e2', 'e3']) low.put(id);
  expect(low.approve(['e1', 'e2', 'e3']).handed_off).toHaveLength(2);
  const high = setup({ batch: true, cap: 40 });
  expect(high.approve(['nope']).cap).toBe(20);
});
