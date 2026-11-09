import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(cleanup);

import { mapRunStatus, mapStatus, sortQueue } from '../src/api/client';
import { parseUnifiedDiff } from '../src/api/diff';
import type { Resource } from '../src/api/resource';
import type { CardSummary, Envelope } from '../src/api/types';
import type { WRun, WStatus } from '../src/api/wire';
import { Fact } from '../src/ui-kit/honest';
import { CHECK_STATUS, probeSpec, runStatusSpec } from '../src/ui-kit/status';

type D = Envelope & { n?: number };
const res = (honesty: Resource<D>['honesty'], data: D | null): Resource<D> => ({
  data,
  error: null,
  honesty,
  asOf: data?.data_as_of ?? null,
  reload: () => {},
});

describe('never show unproven state', () => {
  it('shows a current value plainly', () => {
    render(<Fact res={res('current', { data_as_of: new Date().toISOString(), n: 4 })} pick={(d) => d.n} />);
    expect(screen.getByText('4')).toBeTruthy();
  });
  it('shows Unknown with the last known value when stale', () => {
    render(
      <Fact
        res={res('stale', { data_as_of: new Date(Date.now() - 12 * 60000).toISOString(), n: 4 })}
        pick={(d) => d.n}
      />,
    );
    expect(screen.getByText('Unknown')).toBeTruthy();
    expect(screen.getByText(/Last known: 4, 12 min ago/)).toBeTruthy();
  });
  it('never turns a missing value into zero', () => {
    render(<Fact res={res('current', { data_as_of: new Date().toISOString() })} pick={(d) => d.n} />);
    expect(screen.getByText('Unknown')).toBeTruthy();
  });
  it('treats skipped checks and never-run probes as not verified', () => {
    expect(CHECK_STATUS.skipped.tone).toBe('unknown');
    expect(probeSpec('never').word).toMatch(/Not verified/);
    expect(probeSpec('pass', 'branch').word).toMatch(/not verified on merged code/);
  });
  it('only says Running with a fresh heartbeat', () => {
    const now = Date.now();
    expect(runStatusSpec('running', new Date(now - 30_000).toISOString(), now).word).toBe('Running');
    expect(runStatusSpec('running', new Date(now - 300_000).toISOString(), now).word).toMatch(
      /No signal since/,
    );
    expect(runStatusSpec('running', undefined, now).word).toBe('No signal');
  });
});

describe('wire mapping (LOCAL-API-V1.md)', () => {
  const run = (o: Partial<WRun>) =>
    ({ status: 'succeeded', failure_class: null, artifacts: [], ...o }) as WRun;
  it('maps run statuses as agreed with Core', () => {
    expect(mapRunStatus(run({ status: 'validating' }))).toBe('checking');
    expect(mapRunStatus(run({ status: 'killed' }))).toBe('halted');
    expect(mapRunStatus(run({ status: 'succeeded' }))).toBe('finished_unchecked');
    expect(
      mapRunStatus(
        run({
          status: 'succeeded',
          artifacts: [
            {
              kind: 'pull_request',
              ref: 'x',
              sha: null,
              claimed_by_agent: 1,
              verified_by_kernel: 1,
              verified_at: null,
            },
          ],
        }),
      ),
    ).toBe('artifact_verified');
    expect(mapRunStatus(run({ status: 'failed', failure_class: 'claim_mismatch' }))).toBe(
      'claimed_unverified',
    );
  });
  it('says Stopping until every run is halted', () => {
    const base = {
      daemon: 'up',
      version: 'x',
      started_at: '',
      chain: { ok: true, head_seq: 1, head_hash: '', verified_at: '' },
      sandbox_level: 'enforced',
      open_cards: 0,
      running_runs: 0,
    } as const;
    expect(
      mapStatus({ ...base, kill: { engaged: true, runs_to_halt: 9, runs_halted: 6 } } as WStatus, '')
        .kill_switch.state,
    ).toBe('stopping');
    expect(
      mapStatus({ ...base, kill: { engaged: true, runs_to_halt: 9, runs_halted: 9 } } as WStatus, '')
        .kill_switch.state,
    ).toBe('stopped');
    expect(mapStatus({ ...base, kill: { engaged: false } } as WStatus, '').spend_today).toBeUndefined();
  });
  it('sorts the queue by deadline, then urgency, then age', () => {
    const c = (id: string, o: Partial<CardSummary>) =>
      ({
        id,
        variant: 'approve',
        title: id,
        created_at: '2026-11-09T10:00:00Z',
        urgency: 'whenever',
        state: 'open',
        ...o,
      }) as CardSummary;
    const q = sortQueue([
      c('old', { created_at: '2026-11-08T10:00:00Z' }),
      c('due', { deadline_at: '2026-11-09T16:00:00Z' }),
      c('now', { urgency: 'now' }),
    ]);
    expect(q.map((x) => x.id)).toEqual(['due', 'now', 'old']);
  });
  it('parses a unified diff with exact line text', () => {
    const f = parseUnifiedDiff(
      'diff --git a/x.ts b/x.ts\nnew file mode 100644\n--- /dev/null\n+++ b/x.ts\n@@ -0,0 +1,2 @@\n+a\n+  b\n',
    );
    expect(f[0]).toMatchObject({ path: 'x.ts', status: 'added' });
    expect(f[0].hunks[0].lines).toEqual([
      { n: 5, op: '+', text: 'a' },
      { n: 6, op: '+', text: '  b' },
    ]);
  });
});
