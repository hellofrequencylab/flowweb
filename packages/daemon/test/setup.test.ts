// FW-C-038: the setup report reads real state only, and names a fix for every step not done.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '@fw/eventlog';
import { addProject, briefProject } from '@fw/ledger';
import { afterAll, describe, expect, test } from 'vitest';
import { REPO_ROOT } from '../src/daemon.ts';
import { setFlowEnabled } from '../src/overseer/index.ts';
import { RELAY_PUSH_FILE, setupReport } from '../src/setup/index.ts';
import { seed, tempHome, withWriter } from './api-fixtures.ts';

const home = tempHome();
afterAll(() => home.cleanup());
const NOW = new Date('2026-11-10T12:00:00.000Z');

function report(fwdUp = true) {
  const store = openStore({
    path: join(home.path, 'db', 'fw.sqlite'),
    readonly: true,
    lockPath: join(home.path, 'fwd.lock'),
  });
  try {
    return setupReport({
      reader: store.reader(),
      fwHome: home.path,
      repoRoot: REPO_ROOT,
      fwdUp,
      port: 7317,
      now: NOW,
      nodeVersion: '22.1.0',
    });
  } finally {
    store.close();
  }
}
const step = (r: ReturnType<typeof report>, id: string) => r.steps.find((s) => s.id === id)!;

describe('setup report', () => {
  test('with no database, nothing is done and every step has a fix', () => {
    const r = setupReport({
      reader: null,
      fwHome: home.path,
      repoRoot: REPO_ROOT,
      fwdUp: false,
      nodeVersion: '24.0.0',
    });
    expect(r.ready).toBe(false);
    expect(r.next).toBe('machine');
    expect(r.steps.every((s) => !s.done && s.fix)).toBe(true);
    expect(step(r, 'machine').fix).toMatch(/Node 22.*pnpm fwd/);
  });

  test('steps tick only from what is true, in order', () => {
    seed(home.path);
    let r = report();
    expect(step(r, 'machine').done).toBe(true);
    expect(r.next).toBe('sign_ins');

    writeFileSync(
      join(home.path, 'accounts-check.json'),
      JSON.stringify({
        checked_at: NOW.toISOString(),
        accounts: [{ id: 'codex_signin', label: 'ChatGPT', ok: true }],
        start_command: 'FW_CODEX_AUTH=signin pnpm fwd',
      }),
    );
    r = report(false);
    expect(step(r, 'sign_ins').done).toBe(true);
    expect(step(r, 'machine').fix).toContain('FW_CODEX_AUTH=signin pnpm fwd');

    withWriter(home.path, (w) =>
      addProject(w, { slug: 'launch', brand: 'Frequency', category: 'marketing' }),
    );
    r = report();
    expect(step(r, 'project').done).toBe(true);
    expect(step(r, 'brief').fix).toBe('pnpm fw project brief launch');

    withWriter(home.path, (w) =>
      briefProject(w, 'launch', { what: 'a', who: 'b', voice: 'c', never: 'd', done: 'e' }),
    );
    r = report();
    expect(step(r, 'brief').done).toBe(true);
    expect(step(r, 'flow').fix).toMatch(/^pnpm fw supervisor enable \S+$/);

    const key = /enable (\S+)$/.exec(step(r, 'flow').fix!)![1]!;
    withWriter(home.path, (w) => setFlowEnabled(w, REPO_ROOT, key, true));
    r = report();
    expect(r.ready).toBe(true);
    expect(r.next).toBeNull();
    expect(step(r, 'live_site').done).toBe(false);

    const pushed = (min: number) =>
      writeFileSync(
        join(home.path, RELAY_PUSH_FILE),
        JSON.stringify({ synced_at: new Date(NOW.getTime() - min * 60_000).toISOString() }),
      );
    pushed(5);
    expect(step(report(), 'live_site').done).toBe(true);
    pushed(60);
    expect(step(report(), 'live_site').done).toBe(false);
  });
});
