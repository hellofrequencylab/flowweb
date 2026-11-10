// FW-C-071: fwd reads the sender's heartbeat and says whether a sender reads the outbox.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { senderStatus } from '../src/overseer/sender.ts';

const home = () => mkdtempSync(join(tmpdir(), 'fw-sender-'));
const beat = (h: string, body: string) => {
  mkdirSync(join(h, 'senders', 'email'), { recursive: true });
  writeFileSync(join(h, 'senders', 'email', 'last-pass.json'), body);
};
const now = new Date('2026-11-10T18:00:00Z');

describe('senderStatus', () => {
  test('no heartbeat is no sender', () => {
    expect(senderStatus(home(), now)).toEqual({ installed: false, last_pass_at: null });
  });
  test('a pass in the last day is a sender', () => {
    const h = home();
    beat(h, JSON.stringify({ at: '2026-11-10T17:40:00Z', ok: true, sent: 0 }));
    expect(senderStatus(h, now)).toEqual({ installed: true, last_pass_at: '2026-11-10T17:40:00Z' });
  });
  test('an older pass keeps its time but is not a sender', () => {
    const h = home();
    beat(h, JSON.stringify({ at: '2026-11-09T17:59:00Z' }));
    expect(senderStatus(h, now)).toEqual({ installed: false, last_pass_at: '2026-11-09T17:59:00Z' });
  });
  test('an unreadable heartbeat is no sender', () => {
    const h = home();
    beat(h, '{ not json');
    expect(senderStatus(h, now)).toEqual({ installed: false, last_pass_at: null });
    beat(h, JSON.stringify({ at: 'yesterday' }));
    expect(senderStatus(h, now)).toEqual({ installed: false, last_pass_at: null });
  });
});
