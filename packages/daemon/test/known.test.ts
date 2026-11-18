// FW-C-155: a hunt is told who was already contacted, and Today never asks about a drafted lead on its own.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { KNOWN_FILE, knownContacts, knownRule } from '../src/flows/known.ts';
import { todayView } from '../src/flows/today.ts';

const KEY = 'neighborhood-activation';
const NOW = new Date('2026-11-18T19:00:00.000Z');
const DAY = 86_400_000;
const at = (d: number) => new Date(NOW.getTime() + d * DAY).toISOString();
const put = (p: string, name: string, doc: unknown) => {
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, name), JSON.stringify(doc));
};

test('known contacts come from the flow and its copies, newest first, and only while still held', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-known-'));
  const base = join(home, 'flows', KEY);
  const copy = join(home, 'copies', `${KEY}--coaches-guides`, 'flows', KEY);
  put(base, 'state.json', {
    hunt_contacts: {
      'ana@example.com': { at: at(-3), hunt_id: 'h1', event_url: 'https://example.com/e/a' },
      'https://example.com/contact': { at: at(-1), hunt_id: 'h1', event_url: 'https://example.com/e/b' },
    },
  });
  put(join(base, 'drafts'), 'a.json', {
    to: 'Ana@Example.com',
    name: 'Ana',
    source_url: 'https://example.com/ana',
  });
  put(join(base, 'drafts'), 'b.json', { contact_url: 'https://example.com/contact', name: 'The Barn' });
  // A retired draft freed this contact, so it is not known any more.
  put(join(base, 'drafts'), 'c.json', { to: 'freed@example.com', name: 'Freed', status: 'rejected' });
  put(join(base, 'drafts'), 'broken.json', 'not a draft');
  put(copy, 'state.json', { hunt_contacts: { 'coach@example.com': { at: at(-2), hunt_id: 'h2' } } });
  put(join(home, 'copies', 'other-flow--x', 'flows', 'other-flow'), 'state.json', {
    hunt_contacts: { 'else@example.com': { at: at(0) } },
  });

  expect(knownContacts(home, KEY)).toEqual([
    { name: 'The Barn', contact: 'https://example.com/contact', page: null },
    { name: null, contact: 'coach@example.com', page: null },
    { name: 'Ana', contact: 'ana@example.com', page: 'https://example.com/ana' },
  ]);
  expect(knownContacts(home, KEY, 1)).toHaveLength(1);
  expect(knownContacts(mkdtempSync(join(tmpdir(), 'fw-known-')), KEY)).toEqual([]);
});

test('the brief only mentions the list when there is one', () => {
  expect(knownRule(0)).toEqual([]);
  const [line] = knownRule(3);
  expect(line).toContain(KNOWN_FILE);
  expect(line).toContain('3 organizers');
  expect(line).not.toMatch(/[—–]/);
});

test('Today asks about a lead with no draft, never about one a hunt already drafted for', () => {
  const home = mkdtempSync(join(tmpdir(), 'fw-known-'));
  const base = join(home, 'flows', KEY);
  const lead = (id: string, to: string) => ({ id, name: id, state: 'proposed', score: { value: 0.5 }, to });
  put(base, 'leads.json', {
    nodes: [
      lead('retired', 'retired@example.com'),
      lead('aged', 'aged@example.com'),
      lead('sent', 'sent@example.com'),
      lead('met', 'met@example.com'),
    ],
  });
  const draft = (id: string, extra: Record<string, unknown>) =>
    put(join(base, 'drafts'), `${id}.json`, {
      id,
      hunt_id: 'h1',
      to: `${id}@example.com`,
      subject: 'Hello',
      body: 'Hi there, a short note.',
      status: 'waiting_for_owner',
      created_at: at(-1),
      ...extra,
    });
  draft('retired', { status: 'rejected', retired: 'event_passed' });
  draft('aged', { created_at: at(-6) });
  draft('sent', { sent_at: at(-1) });
  const asked = todayView({ fwHome: home, flow: KEY, size: 15, now: NOW })
    .actions.filter((a) => a.kind === 'approve_lead')
    .map((a) => a.lead_id);
  expect(asked).toEqual(['met']);
});
