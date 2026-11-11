// Parking a row by hand: the Owner retires a row with a reason, and the move is refused where the
// schema does not allow it.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '@fw/eventlog';
import { describe, expect, test } from 'vitest';
import { dbPath, getDbRow, parkRow, syncRows, transitionRow } from '../src/index.ts';
import { fwHome, PROJECT, row, tempDir, writeRows } from './helpers.ts';

const dir = tempDir();

function store(name: string) {
  const home = fwHome(join(dir, name));
  mkdirSync(join(home, 'db'), { recursive: true });
  const s = openStore({ path: dbPath(home), lockPath: join(home, 'fwd.lock') });
  syncRows(s.writer!, { rowsDir: writeRows(join(dir, `${name}-rows`), [row('FW-C-961')]), project: PROJECT });
  return s;
}

describe('ledger park', () => {
  test('parks an open row and records the reason on its status event', () => {
    const s = store('park-open');
    const r = parkRow(s.writer!, 'FW-C-961', { reason: 'superseded by the flows home' });
    expect(r).toMatchObject({ code: 'FW-C-961', from: 'open', to: 'parked' });
    expect(getDbRow(s.writer!, 'FW-C-961').status).toBe('parked');
    const ev = s.writer!.get<{ payload: string }>(
      "SELECT payload FROM events WHERE type = 'ledger.row_status_changed' ORDER BY seq DESC LIMIT 1",
    );
    expect(JSON.parse(ev!.payload).guard_evidence).toEqual({
      reason: 'owner_parked',
      note: 'superseded by the flows home',
    });
    s.close();
  });

  test('needs a reason', () => {
    const s = store('park-noreason');
    expect(() => parkRow(s.writer!, 'FW-C-961', { reason: ' ' })).toThrow(/reason/);
    expect(getDbRow(s.writer!, 'FW-C-961').status).toBe('open');
    s.close();
  });

  test('refuses a row that cannot be parked, and changes nothing', () => {
    const s = store('park-claimed');
    transitionRow(s.writer!, 'FW-C-961', 'parked');
    expect(() => parkRow(s.writer!, 'FW-C-961', { reason: 'again' })).toThrow(
      /illegal ledger_row transition/,
    );
    expect(getDbRow(s.writer!, 'FW-C-961').status).toBe('parked');
    s.close();
  });
});
