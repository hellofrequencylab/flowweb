// Adapter conformance suite (WS-P0-027). Every adapter runs the same cases; a harness maps each
// case to an input that provokes it (a fake scenario, a replayed transcript, or a live call).
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import type { StartOptions, VendorAdapter, VendorAdapterInput } from '../src/index.ts';
import { findSecrets } from '../src/index.ts';
import {
  type Collected,
  collect,
  FAKE_MARKER,
  liveGroupMembers,
  makeWorktree,
  schemaErrors,
  steps,
  type Worktree,
  waitGroupGone,
} from './helpers.ts';

export const CASES = [
  'success',
  'nonzero_exit',
  'missing_result',
  'budget_cap',
  'wall_clock',
  'session_id',
  'secret_redaction',
  'kill',
] as const;
export type CaseKind = (typeof CASES)[number];

export interface CaseSetup {
  input: VendorAdapterInput;
  opts?: StartOptions;
  /** Per-case adapter (for example one bound to a replay fixture). Defaults to the harness adapter. */
  adapter?: VendorAdapter;
}

export interface Harness {
  label: string;
  skip?: boolean;
  adapter: () => VendorAdapter;
  /** Return null when the harness cannot provoke the case (the test is then skipped). */
  setup: (kind: CaseKind, wt: Worktree) => CaseSetup | null;
}

async function runCase(
  h: Harness,
  kind: CaseKind,
  body: (c: Collected, s: CaseSetup) => Promise<void> | void,
) {
  const wt = makeWorktree();
  try {
    const s = h.setup(kind, wt);
    if (!s) return;
    const c = await collect((s.adapter ?? h.adapter()).start(s.input, s.opts));
    commonChecks(c);
    await body(c, s);
  } finally {
    wt.cleanup();
  }
}

/** Invariants every run must satisfy, whatever its outcome. */
export function commonChecks(c: Collected): void {
  expect(schemaErrors('run-result.json', c.result)).toEqual([]);
  const st = steps(c.events);
  st.forEach((s, i) => {
    expect(s.seq).toBe(i);
    expect(s.id.startsWith('stp_')).toBe(true);
    expect(s.content_hash).toBe(createHash('sha256').update(s.content).digest('hex'));
    expect(s.content_ref).toBeNull();
  });
  if (c.result.status !== 'refused') expect(st[0]?.kind).toBe('prompt');
}

async function expectGroupGone(pgid: number | null): Promise<void> {
  expect(pgid).not.toBeNull();
  if (pgid === null) return;
  expect(liveGroupMembers(pgid)).toEqual([]);
  expect(await waitGroupGone(pgid)).toBe(true);
  expect(() => process.kill(-pgid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
}

export function conformanceSuite(h: Harness): void {
  describe.skipIf(h.skip)(`adapter conformance: ${h.label}`, () => {
    test('success: schema-valid result with an artifact and exit 0', async () => {
      await runCase(h, 'success', (c) => {
        expect(c.result.status).toBe('completed');
        expect(c.result.exit_code).toBe(0);
        expect(c.result.artifacts.length).toBeGreaterThan(0);
        expect(c.meta.failure_class).toBeNull();
        expect(c.meta.fingerprint?.help_sha256).toMatch(/^[0-9a-f]{64}$/);
      });
    });

    test('nonzero exit equals failure', async () => {
      await runCase(h, 'nonzero_exit', (c) => {
        expect(c.result.status).toBe('failed');
        expect(c.result.exit_code).not.toBe(0);
        expect(c.meta.failure_class).toBe('nonzero_exit');
      });
    });

    test('missing structured output equals failure', async () => {
      await runCase(h, 'missing_result', (c) => {
        expect(c.result.status).toBe('failed');
        expect(c.meta.failure_class).toBe('schema');
      });
    });

    test('budget cap honored: group killed, breach recorded', async () => {
      await runCase(h, 'budget_cap', async (c) => {
        expect(c.result.status).toBe('budget_exceeded');
        expect(c.meta.cap_breach).not.toBeNull();
        expect(c.events.some((e) => e.type === 'cap_breach')).toBe(true);
        await expectGroupGone(c.meta.pgid);
      });
    });

    test('wall-clock cap honored within 2 s', async () => {
      await runCase(h, 'wall_clock', async (c, s) => {
        expect(c.result.status).toBe('timeout');
        expect(c.meta.cap_breach?.cap).toBe('wall_clock');
        const elapsed = Date.parse(c.result.ended_at!) - Date.parse(c.result.started_at!);
        expect(elapsed).toBeLessThan(s.input.caps.max_wall_clock_s * 1000 + 2000 + 1000);
        await expectGroupGone(c.meta.pgid);
      });
    });

    test('session id stored', async () => {
      await runCase(h, 'session_id', (c) => {
        const ev = c.events.find((e) => e.type === 'session');
        expect(ev).toBeDefined();
        expect(c.result.session_id.length).toBeGreaterThan(0);
        if (ev?.type === 'session') expect(c.result.session_id).toBe(ev.session_id);
      });
    });

    test('secret-shaped strings never leave the adapter', async () => {
      await runCase(h, 'secret_redaction', (c, s) => {
        const blob = JSON.stringify([c.events, c.result, c.meta]);
        expect(blob).not.toContain(FAKE_MARKER);
        for (const v of Object.values(s.opts?.credentialEnv ?? {})) expect(blob).not.toContain(v);
        expect(findSecrets(blob)).toEqual([]);
        expect(blob).toContain('[REDACTED:');
      });
    });

    test('kill stops the run and leaves no process behind', async () => {
      const wt = makeWorktree();
      try {
        const s = h.setup('kill', wt);
        if (!s) return;
        const run = (s.adapter ?? h.adapter()).start(s.input, { killGraceMs: 300, ...s.opts });
        const events: Collected['events'] = [];
        const drain = (async () => {
          for await (const e of run.events) {
            events.push(e);
            if (e.type === 'step' && e.step.kind === 'tool_result') void run.kill('test kill');
          }
        })();
        const [result, meta] = await Promise.all([run.result, run.meta]);
        await drain;
        commonChecks({ events, result, meta });
        expect(result.status).toBe('stopped');
        expect(meta.failure_class).toBe('killed');
        expect(events.some((e) => e.type === 'killed')).toBe(true);
        await expectGroupGone(meta.pgid);
      } finally {
        wt.cleanup();
      }
    });
  });
}
