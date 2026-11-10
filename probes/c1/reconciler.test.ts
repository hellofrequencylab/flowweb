// Probe c1/reconciler (WS-P1-006; backlog verify_probe kernel/reconciler).
// Surfaces: `fw ledger sync`, `fw run start` (fake vendor, local bare git host) and `fw ledger close`;
// the git host reconciler exported by packages/daemon/src/index.ts, driven with the Store writer and
// the LocalBareHost of the fixture's bare remote; the ledger_rows table and the
// reconciler.drift_detected, reconciler.completed, ledger.row_created and ledger.row_status_changed
// events of schema.core.sql, read with node:sqlite read-only.
// The export this probe expects (no spec names it; see probes/c1/README.md, "Decisions" 41-45):
//   reconcileGitHost(writer, host, { project? }) -> Promise<{ checked, changes, drift: [{ kind,
//     external_ref, ledger_row_id }] }>; host is a GitHost with listPullRequests()
// Acceptance (WS-P1-006):
//   1. a PR merged outside the tool moves its row to merged (merging, with merged_sha recorded, one
//      reconciler.drift_detected missed_webhook) and queues the probe (fw ledger close on the merged
//      commit then runs it and moves the row on to watching)
//   2. an open PR with no row creates an orphan_pr row (a ledger row in open, owned by the Owner,
//      linking the PR, with one ledger.row_created and one reconciler.drift_detected orphan_pr)
//   3. a reconcile pass is idempotent: a second pass reports zero changes and adds no row, no status
//      change and no drift event
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  count,
  fail,
  fixtureProject,
  fw,
  fwJson,
  git,
  openDbReadonly,
  pipelineEnv,
  pipelineHome,
  requireExport,
  root,
  rowStatusOf,
} from '../c0/_lib.mjs';

type Report = { checked: number; changes: number; drift: { kind: string; external_ref: string; ledger_row_id: string | null }[] };
type Reconcile = (w: unknown, host: unknown, opts?: unknown) => Promise<Report>;

const ROW = 'WS-P1-006';

describe('c1/reconciler', () => {
  test('repairs a merge made outside the tool, opens a row for an orphan PR, and a second pass changes nothing', async () => {
    const reconcileGitHost = (await requireExport('daemon', 'reconcileGitHost', ROW)) as Reconcile;
    const { LocalBareHost } = await import(pathToFileURL(join(root, 'packages/daemon/src/index.ts')).href);
    const { openStore } = await import(pathToFileURL(join(root, 'packages/eventlog/src/index.ts')).href);

    const proj = fixtureProject({ rowId: 'FW-C-967' });
    const home = pipelineHome('c1-recon');
    const o = { home, cwd: proj.work, env: pipelineEnv() };
    expect(fw(['ledger', 'sync', '--json'], o).status, 'fw ledger sync').toBe(0);
    const run = fwJson(['run', 'start', 'FW-C-967', '--adapter', 'fake'], o);
    if (run.status !== 0) fail(`fw run start FW-C-967 exited ${run.status}: ${run.stdout.slice(0, 300)}`);
    let db = await openDbReadonly(home);
    expect(rowStatusOf(db, 'FW-C-967'), 'the run leaves its row in verifying').toBe('verifying');
    db.close();

    // The Owner merges the run's PR on the host, outside the tool; someone also opens a PR by hand.
    const host = new LocalBareHost(proj.remote);
    const merged = await host.merge(1);
    git(proj.work, 'checkout', '-q', '-b', 'hand/change');
    git(proj.work, 'commit', '-q', '--allow-empty', '-m', 'a change nobody filed');
    git(proj.work, 'push', '-q', 'origin', 'hand/change');
    git(proj.work, 'checkout', '-q', 'main');
    const orphan = await host.openPullRequest({ title: 'Hand-made change', body: 'no row', head: 'hand/change', base: 'main' });

    const pass = async (): Promise<Report> => {
      const store = openStore({ path: join(home, 'db', 'fw.sqlite'), lockPath: join(home, 'fwd.lock') });
      try {
        return await reconcileGitHost(store.writer, host);
      } finally {
        store.close();
      }
    };
    const first = await pass();
    expect(first.checked, 'both PRs were checked').toBeGreaterThanOrEqual(2);

    db = await openDbReadonly(home);
    const row = db.prepare("SELECT status, merged_sha FROM ledger_rows WHERE id = 'lr_FWC967'").get() as Record<string, string>;
    expect(row.status, 'the merged PR moves its row to merging').toBe('merging');
    expect(row.merged_sha).toBe(merged.merged_sha);
    const drift = (db.prepare("SELECT payload FROM events WHERE type = 'reconciler.drift_detected' ORDER BY seq").all() as { payload: string }[]).map(
      (r) => JSON.parse(r.payload),
    );
    expect(drift.filter((d) => d.kind === 'missed_webhook' && d.ledger_row_id === 'lr_FWC967').length, 'one missed_webhook drift').toBe(1);

    const orphans = db.prepare('SELECT id, status, owner_kind, links FROM ledger_rows WHERE links LIKE ?').all(`%${orphan.url}%`) as Record<string, string>[];
    if (orphans.length !== 1) fail(`expected one ledger row linking the orphan PR ${orphan.url}; found ${orphans.length}`);
    expect([orphans[0]!.status, orphans[0]!.owner_kind]).toEqual(['open', 'owner']);
    expect(drift.filter((d) => d.kind === 'orphan_pr' && d.ledger_row_id === orphans[0]!.id).length, 'one orphan_pr drift').toBe(1);
    const created = db.prepare("SELECT count(*) AS n FROM events WHERE type = 'ledger.row_created' AND payload LIKE ?").get(`%${orphans[0]!.id}%`) as { n: number };
    expect(created.n, 'one ledger.row_created for the orphan row').toBe(1);
    const before = {
      rows: count(db, 'SELECT count(*) FROM ledger_rows'),
      drift: count(db, "SELECT count(*) FROM events WHERE type = 'reconciler.drift_detected'"),
      moves: count(db, "SELECT count(*) FROM events WHERE type = 'ledger.row_status_changed'"),
      created: count(db, "SELECT count(*) FROM events WHERE type = 'ledger.row_created'"),
    };
    expect(count(db, "SELECT count(*) FROM events WHERE type = 'reconciler.completed'"), 'a pass records reconciler.completed').toBeGreaterThanOrEqual(1);
    db.close();

    // Acceptance 3: the second pass is a no-op.
    const second = await pass();
    expect(second.changes, 'second pass changes').toBe(0);
    expect(second.drift.length, 'second pass drift').toBe(0);
    db = await openDbReadonly(home);
    const after = {
      rows: count(db, 'SELECT count(*) FROM ledger_rows'),
      drift: count(db, "SELECT count(*) FROM events WHERE type = 'reconciler.drift_detected'"),
      moves: count(db, "SELECT count(*) FROM events WHERE type = 'ledger.row_status_changed'"),
      created: count(db, "SELECT count(*) FROM events WHERE type = 'ledger.row_created'"),
    };
    db.close();
    expect(after).toEqual(before);

    // The queued probe: closing on the merged commit runs it and moves the row on to watching.
    git(proj.work, 'fetch', '-q', 'origin', 'main');
    git(proj.work, 'checkout', '-q', '--detach', merged.merged_sha);
    const close = fw(['ledger', 'close', 'FW-C-967', '--merged-sha', merged.merged_sha, '--json'], o);
    expect(close.status, `fw ledger close on the merged commit exited ${close.status}: ${(close.stdout + close.stderr).slice(0, 300)}`).toBe(0);
    db = await openDbReadonly(home);
    expect(rowStatusOf(db, 'FW-C-967'), 'a passing probe on the merged commit moves merging -> watching').toBe('watching');
    db.close();
  });
});
