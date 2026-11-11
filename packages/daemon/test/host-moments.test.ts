// FW-C-106: host moments turns Frequency host events into drafts for the Owner.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { scanEvents } from '../src/flows/host-moments.ts';

const repoRoot = resolve(import.meta.dirname, '../../..');
const now = new Date('2026-11-11T18:00:00Z');
const at = '2026-11-11T16:00:00Z';
const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function home(): string {
  const h = mkdtempSync(join(tmpdir(), 'fw-host-moments-'));
  homes.push(h);
  mkdirSync(join(h, 'flows/host-moments/events'), { recursive: true });
  return h;
}
const drop = (h: string, name: string, ev: unknown) =>
  writeFileSync(join(h, 'flows/host-moments/events', `${name}.json`), JSON.stringify(ev));
const waiting = (h: string) =>
  readdirSync(join(h, 'flows/host-moments/events')).filter((f) => f.endsWith('.json'));
const drafts = (h: string) => {
  const dir = join(h, 'flows/host-moments/drafts');
  return existsSync(dir)
    ? readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>)
    : [];
};
const ev = (type: string, host: string, extra: Record<string, unknown> = {}) => ({
  type,
  at,
  space_id: `spc_${host}`,
  host_id: host,
  ...extra,
});

describe('scanEvents', () => {
  test('with the flow off only opt-outs are handled; every other event waits', async () => {
    const h = home();
    drop(h, 'a', ev('event.filled', 'h1', { event_title: 'Jam' }));
    drop(h, 'b', ev('host.opted_out', 'h2'));
    const r = await scanEvents({ repoRoot, fwHome: h, now, draft: false });
    expect(r.processed).toBe(1);
    expect(waiting(h)).toEqual(['a.json']);
    expect(drafts(h)).toEqual([]);
  });

  test('an unreadable or unknown file moves to done with a reason; the same event twice drafts once', async () => {
    const h = home();
    writeFileSync(join(h, 'flows/host-moments/events/broken.json'), '{');
    drop(h, 'odd', ev('link.paused', 'h1'));
    drop(h, 'one', ev('event.filled', 'h1', { event_title: 'Jam' }));
    drop(h, 'two', ev('event.filled', 'h1', { event_title: 'Jam' }));
    const r = await scanEvents({ repoRoot, fwHome: h, now, draft: true });
    expect(r.skipped.map((s) => s.file).sort()).toEqual(['broken.json', 'odd.json']);
    expect(drafts(h)).toHaveLength(1);
    expect(waiting(h)).toEqual([]);
  });

  test('an opt-out holds waiting drafts and blocks the lead behind the original draft', async () => {
    const h = home();
    const na = join(h, 'flows/neighborhood-activation/drafts');
    mkdirSync(na, { recursive: true });
    writeFileSync(join(na, 'd1.json'), JSON.stringify({ id: 'd1', tag: 'fire1-d1', to: 'Host@Example.com' }));
    drop(h, 'a', ev('event.filled', 'h1', { event_title: 'Jam' }));
    await scanEvents({ repoRoot, fwHome: h, now, draft: true });
    drop(h, 'b', ev('host.opted_out', 'h1', { ref: 'yoga.fire1-d1' }));
    await scanEvents({ repoRoot, fwHome: h, now, draft: true });
    const state = JSON.parse(readFileSync(join(h, 'flows/neighborhood-activation/state.json'), 'utf8'));
    expect(state.do_not_contact).toEqual(['frequency-host:h1', 'host@example.com']);
    expect(drafts(h)[0]?.held).toBe('opted_out');
  });

  test('an event published after the thank-you gets its own share kit, once', async () => {
    const h = home();
    drop(h, 'a', ev('space.published', 'h1', { detail: 'Drum Circle' }));
    await scanEvents({ repoRoot, fwHome: h, now, draft: true });
    expect(drafts(h)[0]?.body).toMatch(/When your first event is up/);
    const published = ev('event.published', 'h1', {
      event_id: 'e1',
      title: 'Drum Night',
      starts_at: '2026-11-20T03:00:00Z',
      rsvp_url: 'https://frequencylocal.com/e/drum',
    });
    drop(h, 'b', published);
    drop(h, 'c', { ...published, at: '2026-11-11T17:00:00Z' });
    await scanEvents({ repoRoot, fwHome: h, now, draft: true });
    const kits = drafts(h).filter((d) => d.kind === 'share_kit');
    expect(kits).toHaveLength(1);
    expect(String(kits[0]?.body)).toContain('https://frequencylocal.com/e/drum?utm_source=flowweb');
  });
});
