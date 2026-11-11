// FW-C-117: launch safety. Live links only while Frequency's funnel pages are not live, no calendar
// fetch to a private address or past the byte cap, region names block, and an opt-out reaches the
// person's waiting drafts in every flow, Today and the roundup heads-ups.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { checkDraft } from '../src/flows/draft-gate.ts';
import { fetchCalendar, privateAddress } from '../src/flows/event-intake.ts';
import { funnelsLive, livePath } from '../src/flows/live-links.ts';
import { dncMatch, doNotContactList, retireDrafts } from '../src/flows/opt-out.ts';
import { todayView } from '../src/flows/today.ts';
import { tempHome } from './api-fixtures.ts';

const NOW = new Date('2026-11-11T17:00:00.000Z');
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
function home() {
  const h = tempHome();
  cleanups.push(h.cleanup);
  return h.path;
}
const put = (h: string, flow: string, doc: Record<string, unknown>) => {
  const dir = join(h, 'flows', flow, 'drafts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${doc.id}.json`), JSON.stringify(doc));
};
const read = (h: string, flow: string, id: string) =>
  JSON.parse(readFileSync(join(h, 'flows', flow, 'drafts', `${id}.json`), 'utf8'));

test('pages that are not live fall back to /create-a-space while the switch is off', () => {
  expect(livePath('/start/host', false)).toBe('/create-a-space');
  expect(livePath('/for/teacher', false)).toBe('/create-a-space');
  expect(livePath('/launch?x=1', false)).toBe('/create-a-space?x=1');
  expect(livePath('/start/partner', false)).toBe('/create-a-space');
  for (const p of ['/pricing', '/help', '/create-a-space', '/e/drum', '/start/event'])
    expect(livePath(p, false)).toBe(p);
  expect(livePath('/start/host', true)).toBe('/start/host');
  expect(funnelsLive({}, {})).toBe(true);
  expect(funnelsLive({ funnels_live: false }, {})).toBe(false);
  expect(funnelsLive({ funnels_live: true }, { FW_FUNNELS_LIVE: 'off' })).toBe(false);
});

test('private, link-local and unique-local addresses are refused, public ones are not', () => {
  for (const ip of [
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '[fe80::1]',
    'fd00::1',
    '::ffff:10.0.0.1',
    '::ffff:a00:1',
    '0.0.0.0',
  ])
    expect(privateAddress(ip), ip).not.toBeNull();
  expect(privateAddress('127.0.0.1')).toBe('loopback');
  expect(privateAddress('::1')).toBe('loopback');
  expect(privateAddress('127.0.0.1', true)).toBeNull();
  for (const ip of ['93.184.216.34', '2606:2800:220:1::1']) expect(privateAddress(ip)).toBeNull();
});

test('a calendar host that resolves to any private address is never fetched', async () => {
  let calls = 0;
  const get = (async () => {
    calls += 1;
    return new Response('BEGIN:VCALENDAR\nEND:VCALENDAR');
  }) as unknown as typeof fetch;
  const lookup = async () => ['93.184.216.34', '10.0.0.7'];
  await expect(fetchCalendar('https://cal.example/x.ics', NOW, get, { lookup })).rejects.toThrow(/private/);
  await expect(fetchCalendar('http://169.254.169.254/latest', NOW, get)).rejects.toThrow(/link-local/);
  await expect(fetchCalendar('http://[fd12::1]/x.ics', NOW, get)).rejects.toThrow(/unique-local/);
  await expect(
    fetchCalendar('http://localhost:9/x.ics', NOW, get, {
      lookup: async () => ['127.0.0.1'],
      allowLoopback: false,
    }),
  ).rejects.toThrow(/loopback/);
  await expect(fetchCalendar('http://127.0.0.1:7317/v1/x', NOW, get)).rejects.toThrow(/FlowWeb itself/);
  expect(calls).toBe(0);
});

test('a calendar body stops being read at the byte cap', async () => {
  let pulled = 0;
  const chunk = new TextEncoder().encode(`BEGIN:VCALENDAR\n${'X'.repeat(65_000)}\n`);
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled += chunk.byteLength;
      c.enqueue(chunk);
    },
  });
  const get = (async () => new Response(body)) as unknown as typeof fetch;
  const r = await fetchCalendar('https://cal.example/x.ics', NOW, get, {
    lookup: async () => ['93.184.216.34'],
  });
  expect(r.source).toBe('ical');
  expect(pulled).toBeLessThan(2_300_000);
});

test('Canadian provinces and UK nations block by name', () => {
  const body = 'Hi https://frequencylocal.com/x?utm_source=flowweb';
  for (const region of [
    'Ontario',
    'Toronto, ON, Ontario',
    'Quebec',
    'British Columbia',
    'Alberta',
    'Scotland',
    'Wales',
    'England',
    'Northern Ireland',
    'London, UK',
  ])
    expect(
      checkDraft({ body, region, to: 'a@gmail.com' }).blocks.map((b) => b.code),
      region,
    ).toContain('restricted_region');
  for (const region of ['California', 'Encinitas', 'Ukiah'])
    expect(checkDraft({ body, region, to: 'a@gmail.com' }).ok, region).toBe(true);
});

test("an opt-out moves the person's waiting drafts in every flow, and Today leaves them off", () => {
  const h = home();
  put(h, 'neighborhood-activation', {
    id: 'a',
    to: 'Stop@Example.com',
    body: 'Hi',
    status: 'waiting_for_owner',
    created_at: NOW.toISOString(),
  });
  put(h, 'neighborhood-activation', {
    id: 'b',
    to: 'keep@example.com',
    body: 'Hi',
    status: 'waiting_for_owner',
    created_at: NOW.toISOString(),
  });
  put(h, 'host-moments', {
    id: 'c',
    lead_id: 'frequency-host:h1',
    host_id: 'h1',
    body: 'Hi',
    status: 'waiting_for_owner',
  });
  put(h, 'local-pulse', { id: 'd', lead_id: 'host:h1', body: 'Hi', status: 'waiting_for_owner' });
  put(h, 'local-pulse', { id: 'e', lead_id: 'host:h2', body: 'Hi', status: 'handed_off' });
  const moved = retireDrafts(h, ['stop@example.com', 'frequency-host:h1'], NOW.toISOString());
  expect(moved.sort()).toEqual(['host-moments/c', 'local-pulse/d', 'neighborhood-activation/a']);
  expect(read(h, 'neighborhood-activation', 'a').status).toBe('do_not_contact');
  expect(read(h, 'neighborhood-activation', 'b').status).toBe('waiting_for_owner');
  expect(read(h, 'local-pulse', 'e').status).toBe('handed_off');

  // A list entry added any other way keeps the person off Today, by address or by domain.
  put(h, 'neighborhood-activation', {
    id: 'f',
    to: 'x@blocked.org',
    body: 'Hi',
    status: 'waiting_for_owner',
    created_at: NOW.toISOString(),
  });
  mkdirSync(join(h, 'flows', 'neighborhood-activation'), { recursive: true });
  writeFileSync(
    join(h, 'flows', 'neighborhood-activation', 'state.json'),
    JSON.stringify({ do_not_contact: ['@blocked.org'] }),
  );
  expect(doNotContactList(h, 'host-moments')).toEqual(['@blocked.org']);
  expect(dncMatch(['frequency-host:h9'], { lead_id: 'host:h9' })).toBe('frequency-host:h9');
  const ids = todayView({ fwHome: h, flow: 'neighborhood-activation', size: 15, now: NOW }).actions.map(
    (a) => a.draft_id,
  );
  expect(ids).toEqual(['b']);
});

test('the roundup passes the gate, keeps its result, and sends no heads-up to a host who opted out', async () => {
  const h = home();
  const at = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString();
  const ev = (id: string, host: string) => ({
    event_id: id,
    title: `Sound Bath ${id}`,
    starts_at: at(1),
    town: 'Encinitas',
    niche: 'sound',
    rsvp_url: `https://frequencylocal.com/e/${id}`,
    host_id: host,
  });
  mkdirSync(join(h, 'flows', 'local-pulse'), { recursive: true });
  writeFileSync(
    join(h, 'flows', 'local-pulse', 'upcoming.json'),
    JSON.stringify({ events: [ev('a', 'h1'), ev('b', 'h2')] }),
  );
  mkdirSync(join(h, 'flows', 'neighborhood-activation'), { recursive: true });
  writeFileSync(
    join(h, 'flows', 'neighborhood-activation', 'state.json'),
    JSON.stringify({ do_not_contact: ['frequency-host:h1'] }),
  );
  const { runRoundup } = await import('../src/flows/local-pulse-roundup.ts');
  await runRoundup({ repoRoot: join(import.meta.dirname, '../../..'), fwHome: h, env: {}, now: NOW });
  const dir = join(h, 'flows', 'local-pulse', 'drafts');
  const docs = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  const heads = docs.filter((d) => d.kind === 'heads_up').map((d) => d.lead_id);
  expect(heads).toEqual(['host:h2']);
  expect(docs.every((d) => d.gate && Array.isArray(d.gate.blocks))).toBe(true);
  expect(docs.find((d) => d.kind === 'roundup_email')?.status).toBe('waiting_for_owner');
});
