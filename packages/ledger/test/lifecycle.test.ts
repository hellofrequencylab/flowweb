// WS-P0-016 (state machine), WS-P0-020 (premise re-test), WS-P0-021 (close) on a temp git repo.
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from '@fw/contracts';
import { describe, expect, test } from 'vitest';
import {
  closeRow,
  getDbRow,
  isLegalTransition,
  LEDGER_TRANSITIONS,
  nextRow,
  retestPremise,
  runRowProbe,
  showRow,
  transitionRow,
} from '../src/index.ts';
import { fileStore, gitRepo, row, syncInto, tempDir, writeRows } from './helpers.ts';

const dir = tempDir();

function setup(name: string, rows = [row('FW-C-930')]) {
  const store = fileStore(dir, `${name}.sqlite`);
  syncInto(store, writeRows(join(dir, `${name}-rows`), rows));
  const repo = gitRepo(dir, `${name}-repo`);
  return { store, w: store.writer!, repo };
}

const statusOf = (s: ReturnType<typeof setup>['store'], code: string) => getDbRow(s.reader(), code).status;

function eventsOf(s: ReturnType<typeof setup>['store'], type: string) {
  return s
    .reader()
    .all<{ payload: string }>('SELECT payload FROM events WHERE type = ? ORDER BY seq', [type])
    .map((e) => JSON.parse(e.payload) as Record<string, unknown>);
}

describe('state machine', () => {
  test('the TS transition table equals legal_transitions in the schema', () => {
    const { store } = setup('table');
    const db = store
      .reader()
      .all<{ from_state: string; to_state: string }>(
        "SELECT from_state, to_state FROM legal_transitions WHERE machine = 'ledger_row' ORDER BY from_state, to_state",
      )
      .map((r) => `${r.from_state}>${r.to_state}`);
    expect(LEDGER_TRANSITIONS.map(([f, t]) => `${f}>${t}`).sort()).toEqual(db.sort());
    store.close();
  });

  test('open -> running is illegal and changes nothing', () => {
    const { store, w } = setup('illegal');
    expect(isLegalTransition('open', 'running')).toBe(false);
    expect(() => transitionRow(w, 'FW-C-930', 'running')).toThrow(
      /illegal ledger_row transition: FW-C-930 open -> running/,
    );
    expect(statusOf(store, 'FW-C-930')).toBe('open');
    expect(eventsOf(store, 'ledger.row_status_changed')).toEqual([]);
    store.close();
  });

  test('open -> done is legal (a row built outside fwd) but refused without proof', () => {
    const { store, w } = setup('open-done');
    expect(isLegalTransition('open', 'done')).toBe(true);
    expect(isLegalTransition('parked', 'done')).toBe(true);
    expect(() => transitionRow(w, 'FW-C-930', 'done')).toThrow(
      'ledger_rows: done requires last_probe_status=pass',
    );
    expect(statusOf(store, 'FW-C-930')).toBe('open');
    expect(eventsOf(store, 'ledger.row_status_changed')).toEqual([]);
    store.close();
  });

  test('a guard trigger refusal is surfaced with its own message', () => {
    const { store, w } = setup('guard');
    expect(() => transitionRow(w, 'FW-C-930', 'ready')).toThrow(
      'ledger_rows: ready requires premise_valid=1 (premise re-tested and still true)',
    );
    expect(statusOf(store, 'FW-C-930')).toBe('open');
    store.close();
  });

  test('every transition emits ledger.row_status_changed with from, to and guard evidence', () => {
    const { store, w } = setup('events');
    transitionRow(w, 'FW-C-930', 'parked', { guard_evidence: { reason: 'test' } });
    transitionRow(w, 'FW-C-930', 'open');
    expect(eventsOf(store, 'ledger.row_status_changed')).toEqual([
      expect.objectContaining({
        ledger_row_id: 'lr_FWC930',
        from: 'open',
        to: 'parked',
        guard_evidence: { reason: 'test' },
      }),
      expect.objectContaining({ from: 'parked', to: 'open' }),
    ]);
    store.close();
  });
});

describe('premise re-test', () => {
  test('a failing probe moves open -> ready and records premise_retest with its result', async () => {
    const { store, w, repo } = setup('premise-fail');
    const p = await retestPremise(w, 'FW-C-930', { repoDir: repo.dir });
    expect(p).toMatchObject({
      outcome: 'ready',
      still_valid: true,
      from: 'open',
      to: 'ready',
      base_sha: repo.base,
    });
    const db = getDbRow(store.reader(), 'FW-C-930');
    expect(db).toMatchObject({ status: 'ready', premise_valid: 1, last_probe_status: 'fail' });
    expect(eventsOf(store, 'ledger.row_premise_retested')).toEqual([
      expect.objectContaining({ still_valid: true, result: 'probe_fails', retest_nonce: p.result_id }),
    ]);
    expect(eventsOf(store, 'ledger.probe_executed')[0]).toMatchObject({
      status: 'fail',
      target_kind: 'branch',
      target_sha: repo.base,
      exit_code: 1,
      output_tail: 'checking\n',
    });
    expect(nextRow(store.reader())?.code).toBe('FW-C-930');
    store.close();
  });

  test('a probe that already passes parks the row as already satisfied; it is not claimable', async () => {
    const { store, w, repo } = setup('premise-pass');
    writeFileSync(join(repo.dir, 'done.txt'), 'already\n');
    repo.commit('already fixed');
    const p = await retestPremise(w, 'FW-C-930', { repoDir: repo.dir });
    expect(p).toMatchObject({ outcome: 'parked', still_valid: false, to: 'parked' });
    expect(getDbRow(store.reader(), 'FW-C-930')).toMatchObject({ status: 'parked', premise_valid: 0 });
    expect(eventsOf(store, 'ledger.row_status_changed').at(-1)).toMatchObject({
      to: 'parked',
      guard_evidence: expect.objectContaining({ reason: 'already_satisfied' }),
    });
    expect(nextRow(store.reader())).toBeNull();
    expect(() => transitionRow(w, 'FW-C-930', 'claimed')).toThrow(/illegal ledger_row transition/);
    store.close();
  });

  test('a probe that times out is inconclusive: the row stays open', async () => {
    const { store, w, repo } = setup('premise-timeout', [row('FW-C-931', { verify_probe: 'sleep 30' })]);
    const p = await retestPremise(w, 'FW-C-931', { repoDir: repo.dir, timeoutMs: 300 });
    expect(p).toMatchObject({ outcome: 'unchanged', still_valid: null, to: 'open' });
    expect(p.probe.timed_out).toBe(true);
    expect(eventsOf(store, 'ledger.row_premise_retested')[0]).toMatchObject({ result: 'inconclusive' });
    store.close();
  });
});

/** Drives a row to verifying the way C0 does: premise re-test, then claimed, running, verifying. */
async function toVerifying(s: ReturnType<typeof setup>, code = 'FW-C-930') {
  await retestPremise(s.w, code, { repoDir: s.repo.dir });
  for (const to of ['claimed', 'running', 'verifying'] as const) transitionRow(s.w, code, to);
}

describe('close', () => {
  test('close with a passing probe on the merged commit moves verifying -> done with a bundle bound to merged_sha', async () => {
    const s = setup('close-pass');
    await toVerifying(s);
    writeFileSync(join(s.repo.dir, 'done.txt'), 'done\n');
    const merged = s.repo.commit('the work');
    const c = await closeRow(s.w, 'FW-C-930', { mergedSha: merged, repoDir: s.repo.dir });
    expect(c).toMatchObject({
      status: 'done',
      merged_sha: merged,
      probe: { exit_code: 0, output_tail: 'checking\n' },
    });
    const db = getDbRow(s.store.reader(), 'FW-C-930');
    expect(db).toMatchObject({
      status: 'done',
      merged_sha: merged,
      evidence_bundle_id: c.bundle_id,
      last_probe_status: 'pass',
    });
    expect(db.closed_at).not.toBeNull();
    const bundle = s.store
      .reader()
      .get<{ subject_sha: string; body: string; bundle_hash: string; captured_by: string }>(
        'SELECT subject_sha, body, bundle_hash, captured_by FROM evidence_bundles WHERE id = ?',
        [c.bundle_id],
      )!;
    expect(bundle.subject_sha).toBe(merged);
    expect(bundle.captured_by).toBe('kernel');
    expect(validate('evidence-bundle', JSON.parse(bundle.body)).errors).toEqual([]);
    // The probe section the bundle is bound to (exit code, output tail, duration) comes back with the row.
    const detail = showRow(s.store.reader(), 'FW-C-930');
    expect(detail.evidence[0]).toMatchObject({ id: c.bundle_id, probe: c.probe });
    expect(validate('ledger-row', detail.contract).errors).toEqual([]);
    // Immutable.
    expect(() => s.w.run('UPDATE evidence_bundles SET scan_red = 1 WHERE id = ?', [c.bundle_id])).toThrow(
      /append-only/,
    );
    expect(eventsOf(s.store, 'evidence.bundle_created')).toHaveLength(1);
    expect(eventsOf(s.store, 'ledger.row_status_changed').at(-1)).toMatchObject({
      from: 'verifying',
      to: 'done',
    });
    expect(s.store.verifyChain().ok).toBe(true);
    s.store.close();
  });

  test('close without a passing probe is refused by the done trigger; no bundle, row stays verifying', async () => {
    const s = setup('close-fail');
    await toVerifying(s);
    writeFileSync(join(s.repo.dir, 'other.txt'), 'not the fix\n');
    const merged = s.repo.commit('not the work');
    await expect(closeRow(s.w, 'FW-C-930', { mergedSha: merged, repoDir: s.repo.dir })).rejects.toMatchObject(
      {
        code: 'REFUSED_BY_DATABASE',
        message: 'ledger_rows: done requires last_probe_status=pass',
      },
    );
    expect(statusOf(s.store, 'FW-C-930')).toBe('verifying');
    expect(s.store.reader().get('SELECT COUNT(*) AS n FROM evidence_bundles')).toEqual({ n: 0 });
    // The failing probe run itself is on the record.
    expect(eventsOf(s.store, 'ledger.probe_executed').at(-1)).toMatchObject({
      status: 'fail',
      target_kind: 'merged',
    });
    s.store.close();
  });

  test('a row built outside fwd closes from open on a passing probe at the merged commit', async () => {
    const s = setup('close-open');
    writeFileSync(join(s.repo.dir, 'done.txt'), 'done\n');
    const merged = s.repo.commit('the work, built by hand');
    const c = await closeRow(s.w, 'FW-C-930', { mergedSha: merged, repoDir: s.repo.dir });
    expect(c).toMatchObject({ status: 'done', merged_sha: merged, probe: { exit_code: 0 } });
    expect(getDbRow(s.store.reader(), 'FW-C-930')).toMatchObject({
      status: 'done',
      merged_sha: merged,
      evidence_bundle_id: c.bundle_id,
    });
    expect(eventsOf(s.store, 'ledger.row_status_changed').at(-1)).toMatchObject({ from: 'open', to: 'done' });
    s.store.close();
  });

  test('a row built outside fwd stays open when its probe fails at the merged commit', async () => {
    const s = setup('close-open-fail');
    await expect(
      closeRow(s.w, 'FW-C-930', { mergedSha: s.repo.base, repoDir: s.repo.dir }),
    ).rejects.toMatchObject({
      code: 'REFUSED_BY_DATABASE',
      message: 'ledger_rows: done requires last_probe_status=pass',
    });
    expect(statusOf(s.store, 'FW-C-930')).toBe('open');
    expect(s.store.reader().get('SELECT COUNT(*) AS n FROM evidence_bundles')).toEqual({ n: 0 });
    s.store.close();
  });

  test('close refuses a row in a state with no step to done, and a checkout not at the merged sha', async () => {
    const s = setup('close-guards');
    transitionRow(s.w, 'FW-C-930', 'blocked');
    await expect(
      closeRow(s.w, 'FW-C-930', { mergedSha: s.repo.base, repoDir: s.repo.dir }),
    ).rejects.toMatchObject({
      code: 'ILLEGAL_TRANSITION',
    });
    transitionRow(s.w, 'FW-C-930', 'open');
    await toVerifying(s);
    await expect(
      closeRow(s.w, 'FW-C-930', { mergedSha: 'a'.repeat(40), repoDir: s.repo.dir }),
    ).rejects.toMatchObject({ code: 'MERGED_SHA_MISMATCH' });
    await expect(closeRow(s.w, 'FW-C-930', { mergedSha: 'abc', repoDir: s.repo.dir })).rejects.toMatchObject({
      code: 'BAD_ARGUMENT',
    });
    s.store.close();
  });

  test('done -> regressed fires automatically on a failing probe re-run', async () => {
    const s = setup('regress');
    await toVerifying(s);
    writeFileSync(join(s.repo.dir, 'done.txt'), 'done\n');
    const merged = s.repo.commit('the work');
    await closeRow(s.w, 'FW-C-930', { mergedSha: merged, repoDir: s.repo.dir });
    const ok = await runRowProbe(s.w, 'FW-C-930', { repoDir: s.repo.dir, target: 'merged' });
    expect(ok.regressed).toBeUndefined();
    expect(statusOf(s.store, 'FW-C-930')).toBe('done');
    rmSync(join(s.repo.dir, 'done.txt'));
    s.repo.commit('revert the work');
    const bad = await runRowProbe(s.w, 'FW-C-930', { repoDir: s.repo.dir, target: 'merged' });
    expect(bad).toMatchObject({ status: 'fail', regressed: true });
    expect(statusOf(s.store, 'FW-C-930')).toBe('regressed');
    expect(eventsOf(s.store, 'ledger.row_regressed')).toEqual([
      expect.objectContaining({
        ledger_row_id: 'lr_FWC930',
        previous_status: 'done',
        failing_result_id: bad.result_id,
      }),
    ]);
    s.store.close();
  });
});
