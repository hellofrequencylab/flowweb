// FW-C-114: a cold lead (first touch from a hunt, never warmed) stops at two touches, and with
// email_opt_in_only an email touch is offered only to a lead that opted in.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { REPO_ROOT } from '../src/daemon.ts';
import { dueTouches, loadSequence } from '../src/flows/sequence.ts';
import { refLinks } from '../src/overseer/drafts.ts';
import { tempHome } from './api-fixtures.ts';

const KEY = 'neighborhood-activation';
const NOW = new Date('2026-11-20T17:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function home() {
  const h = tempHome();
  cleanups.push(h.cleanup);
  const dir = join(h.path, 'flows', KEY, 'drafts');
  mkdirSync(dir, { recursive: true });
  const put = (id: string, extra: Record<string, unknown>) =>
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({ flow: KEY, id, hunt_id: 'hnt_1', send_via: 'social_dm', body: 'Hi', ...extra }),
    );
  return { path: h.path, put };
}

test('a cold lead closes after two touches; a warm one is due for a third', () => {
  const h = home();
  h.put('c1', { sequence_lead: 'cold', sent_at: ago(10) });
  h.put('c2', { sequence_lead: 'cold', sent_at: ago(5) });
  h.put('w1', { sequence_lead: 'warm', warm: true, sent_at: ago(12.5) });
  h.put('w2', { sequence_lead: 'warm', warm: true, sent_at: ago(7.4) });
  const due = dueTouches(KEY, NOW, h.path, REPO_ROOT);
  expect(due.map((d) => [d.lead, d.n])).toEqual([['warm', 3]]);
  expect(loadSequence(h.path, KEY).leads.cold).toMatchObject({
    state: 'closed',
    closed_reason: 'cold_touches',
  });
});

test('with the shipped config, email is offered only to a lead that opted in', () => {
  const h = home();
  h.put('a1', { sequence_lead: 'a', public_email: 'a@example.com', sent_at: ago(5.2) });
  h.put('b1', { sequence_lead: 'b', public_email: 'b@example.com', opted_in_at: ago(9), sent_at: ago(5.2) });
  const due = dueTouches(KEY, NOW, h.path, REPO_ROOT);
  expect(due.map((d) => [d.lead, d.route])).toEqual([
    ['a', 'social_dm'],
    ['b', 'email'],
  ]);
});

test('refLinks adds ref to flowweb links only, and keeps one already there', () => {
  const out = refLinks(
    'A https://x.test/?utm_source=flowweb. B https://x.test/?utm_source=flowweb&ref=k C https://y.test/',
    't',
  );
  expect(out).toBe(
    'A https://x.test/?utm_source=flowweb&ref=t. B https://x.test/?utm_source=flowweb&ref=k C https://y.test/',
  );
});
