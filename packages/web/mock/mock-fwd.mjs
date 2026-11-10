#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
/**
 * Mock fwd: a stand-in for the daemon's local API v1 so the web UI can be
 * built and reviewed before FW-C-018 ships. Speaks the wire format in
 * /mnt/project-files/flowweb-core/LOCAL-API-V1.md (envelope, schema column
 * names, SSE). No dependencies.
 *
 *   node mock/mock-fwd.mjs [--port 7317] [--no-auth] [--scenario normal]
 *
 * Pairing code: 424242. Scenario switcher: http://127.0.0.1:7317/__mock
 * Routes the Core thread has not agreed yet answer with header
 * `x-mock-proposed: 1` so nothing pretends to be the real contract.
 */
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const PORT = Number(arg('--port', process.env.FW_PORT ?? 7317));
const NO_AUTH = args.includes('--no-auth') || process.env.FW_DEV_NO_AUTH === '1';
const PAIR_CODE = '424242';

const backlog = JSON.parse(readFileSync(join(here, 'fixtures/backlog.json'), 'utf8'));
const flowFixture = JSON.parse(readFileSync(join(here, 'fixtures/flow-local-saturation.json'), 'utf8'));
const adsFixture = JSON.parse(readFileSync(join(here, 'fixtures/flow-paid-ads.json'), 'utf8'));
const supervisorFixture = JSON.parse(readFileSync(join(here, 'fixtures/supervisor.json'), 'utf8'));
const activationFixture = withFunnels(
  JSON.parse(readFileSync(join(here, 'fixtures/flow-neighborhood-activation.json'), 'utf8')),
);

/** Builds each lead's funnel link the way the contract does, so the fixture does not repeat it. */
function withFunnels(view) {
  for (const l of view.leads) {
    const fn = view.funnels[l.kind];
    if (!l.send_via || !fn) {
      l.funnel = null;
      continue;
    }
    const q = new URLSearchParams({ persona: fn.persona, region: l.territory_id });
    if (l.sub_area) q.set('area', l.sub_area);
    if (l.channel) q.set('channel', l.channel);
    q.set('src', l.source);
    q.set('utm_source', 'flowweb');
    q.set('utm_medium', l.send_via);
    q.set('utm_campaign', l.territory_id);
    l.funnel = { path: fn.path, persona: fn.persona, url: `${view.offer.url}${fn.path}?${q}` };
  }
  return view;
}

/* ---------------- helpers ---------------- */

const T0 = Date.now();
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
const ahead = (min) => new Date(Date.now() + min * 60_000).toISOString();
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const git = (s) => sha(s).slice(0, 40);
const lr = (code) => `lr_${code.replace(/-/g, '')}`;

/* ---------------- state ---------------- */

let state;
const sessions = new Set();
let seq = 18_200;
const events = [];
const sseClients = new Set();

function emit(type, payload = {}, extra = {}) {
  seq += 1;
  const prev = events.length ? events[events.length - 1].hash : '0'.repeat(64);
  const e = {
    seq,
    id: `evt_${seq}`,
    ts: new Date().toISOString(),
    type,
    version: 1,
    actor_kind: extra.actor_kind ?? 'system',
    actor_id: extra.actor_id ?? 'fwd',
    project_id: extra.project_id ?? 'prj_flowweb',
    stream_id: null,
    work_order_id: null,
    run_id: extra.run_id ?? null,
    correlation_id: `cor_${seq}`,
    causation_id: null,
    idempotency_key: `idem_${seq}`,
    payload,
    payload_hash: sha(JSON.stringify(payload)),
    prev_hash: prev,
  };
  e.hash = sha(`${prev}\n${JSON.stringify(e)}`);
  events.push(e);
  for (const c of sseClients) c.write(`id: ${e.seq}\nevent: fw\ndata: ${JSON.stringify(e)}\n\n`);
  return e;
}

const DIFF_PR41 = `diff --git a/packages/web/src/table/Queue.tsx b/packages/web/src/table/Queue.tsx
new file mode 100644
index 0000000..3b18e51
--- /dev/null
+++ b/packages/web/src/table/Queue.tsx
@@ -0,0 +1,14 @@
+import type { CardSummary } from "../api/types";
+
+/** Waiting cards, sorted by deadline then age. */
+export function Queue({ cards, current, onOpen }: Props) {
+  return (
+    <ol className="queue">
+      {cards.map((c) => (
+        <li key={c.id}>
+          <QueueItem card={c} current={c.id === current} onOpen={onOpen} />
+        </li>
+      ))}
+    </ol>
+  );
+}
diff --git a/packages/web/src/table/Card.tsx b/packages/web/src/table/Card.tsx
index 9c1e2aa..41d07f3 100644
--- a/packages/web/src/table/Card.tsx
+++ b/packages/web/src/table/Card.tsx
@@ -12,9 +12,12 @@ export function Card({ card }: Props) {
   const block = useWriteBlock();
-  const canApprove = !block;
+  // Approve stays locked until the evidence has loaded and matches the payload hash.
+  const canApprove = !block && evidence.status === "loaded" && evidence.payloadHash === card.payload_hash;
   return (
     <article aria-labelledby={headingId}>
-      <h2>{card.title}</h2>
+      <h2 id={headingId}>{card.headline}</h2>
+      <Facts card={card} />
       <Preview card={card} />
diff --git a/packages/web/test/table.test.tsx b/packages/web/test/table.test.tsx
index 77ab012..a8c3f90 100644
--- a/packages/web/test/table.test.tsx
+++ b/packages/web/test/table.test.tsx
@@ -40,6 +40,14 @@ describe("Captain's Table", () => {
     expect(screen.queryByText("Table's clear")).toBeNull();
   });
+
+  it("keeps Approve locked while evidence loads", async () => {
+    render(<Card card={approveCard} />);
+    expect(screen.getByRole("button", { name: /approve/i })).toBeDisabled();
+    expect(screen.getByText(/Loading evidence/)).toBeTruthy();
+  });
 });
`;

const DIFF_PR43 = `diff --git a/packages/web/src/evidence/Evidence.tsx b/packages/web/src/evidence/Evidence.tsx
new file mode 100644
index 0000000..77aa001
--- /dev/null
+++ b/packages/web/src/evidence/Evidence.tsx
@@ -0,0 +1,6 @@
+export function Evidence() {
+  return <section aria-label="Evidence" />;
+}
+
+// fixture used by the screenshot test
+const DEMO_TOKEN = "ghp_REDACTED_BY_FWD";
diff --git a/packages/web/test/evidence.test.tsx b/packages/web/test/evidence.test.tsx
deleted file mode 100644
index 5a5a5a5..0000000
--- a/packages/web/test/evidence.test.tsx
+++ /dev/null
@@ -1,4 +0,0 @@
-it("renders the checklist", () => {
-  render(<Evidence bundle={bundle} />);
-  expect(screen.getByText("Tests")).toBeTruthy();
-});
`;

function initialState(scenario = 'normal') {
  const rows = backlog.map((r) => {
    const status = (() => {
      const map = {
        'FW-C-019': 'watching',
        'FW-C-021': 'awaiting_approval',
        'FW-C-022': 'awaiting_approval',
        'FW-C-020': 'running',
        'FW-C-018': 'verifying',
        'WS-P1-015': 'blocked',
        'FW-C-016': 'parked',
        'FW-C-013': 'regressed',
        'FW-C-024': 'ready',
        'FW-C-025': 'claimed',
        'FW-C-010': 'merging',
      };
      if (map[r.id]) return map[r.id];
      if (r.core_milestone === 'C0') return 'done';
      if (r.core_milestone === 'C1') return ['done', 'done', 'ready', 'open'][r.id.length % 4];
      return 'open';
    })();
    const done = status === 'done' || status === 'watching';
    const probeStatus =
      status === 'done'
        ? 'pass'
        : status === 'regressed'
          ? 'fail'
          : status === 'watching'
            ? 'never'
            : status === 'verifying'
              ? 'pass'
              : 'never';
    const landedRecently = ['WS-P0-043', 'WS-P0-044', 'FW-C-006', 'WS-P0-042'].includes(r.id);
    return {
      id: lr(r.id),
      code: r.id,
      project_id: 'prj_flowweb',
      stream_id: 'str_dev',
      title: r.title,
      description: r.description,
      priority: r.priority,
      lane: r.lane,
      size: r.size,
      status,
      blocked_reason:
        status === 'blocked' ? 'Needs an OpenAI API key with the Codex scope. Waiting on you.' : null,
      depends_on: r.depends_on ?? [],
      links: [],
      wave: r.core_milestone,
      probe_kind: 'command',
      probe_spec: { argv: (r.verify_probe ?? 'pnpm probe unknown').split(' '), cwd: '.', timeout_s: 600 },
      probe_expected: { exit_code: 0 },
      probe_measures: `${r.acceptance?.[0] ?? r.title}.`,
      probe_runs_against: 'merged_artifact',
      probe_hash: sha(`probe:${r.id}`),
      premise_retested_at: status === 'open' ? null : ago(60 * 20),
      premise_valid: status === 'open' ? null : 1,
      merged_sha: done ? git(`merge:${r.id}`) : null,
      last_probe_status: probeStatus,
      last_probe_at: probeStatus === 'never' ? null : landedRecently ? ago(60 * 3) : ago(60 * 30),
      last_probe_sha: probeStatus === 'never' ? null : git(`merge:${r.id}`),
      last_probe_target: status === 'verifying' ? 'branch' : probeStatus === 'never' ? null : 'merged',
      last_probe_output_ref: probeStatus === 'never' ? null : `fw://probe-results/pr_${r.id}`,
      acceptance: (r.acceptance ?? []).map((t, i) => ({
        text: t,
        last_result: status === 'done' ? 'pass' : status === 'regressed' && i === 0 ? 'fail' : 'never',
        at: status === 'done' ? ago(60 * 30) : status === 'regressed' && i === 0 ? ago(50) : null,
      })),
      evidence_bundle_id:
        r.id === 'FW-C-021'
          ? 'evb_pr41'
          : r.id === 'FW-C-022'
            ? 'evb_pr43'
            : r.id === 'FW-C-019'
              ? 'evb_pr39'
              : null,
      last_run_id:
        {
          'FW-C-021': 'run_0041a',
          'FW-C-022': 'run_0043a',
          'FW-C-020': 'run_0044a',
          'FW-C-018': 'run_0040b',
          'FW-C-013': 'run_0031a',
        }[r.id] ?? null,
      watch_until: status === 'watching' ? ahead(60 * 20) : null,
      created_at: ago(60 * 24 * 6),
      updated_at: landedRecently ? ago(60 * 3) : status === 'watching' ? ago(60 * 4) : ago(60 * 26),
      closed_at: status === 'done' ? (landedRecently ? ago(60 * 3) : ago(60 * 30)) : null,
    };
  });

  const runs = [
    run('run_0044a', 'FW-C-020', 'worker', 'anthropic', 'claude-code', 'running', {
      started: 18,
      cost: 0.62,
      heartbeat: 0.1,
      estimated: true,
    }),
    run('run_0045a', 'FW-C-025', 'worker', 'openai', 'codex', 'queued', { started: null, cost: 0 }),
    run('run_0040b', 'FW-C-018', 'verifier', 'openai', 'codex', 'validating', { started: 9, cost: 0.21 }),
    run('run_0043a', 'FW-C-022', 'worker', 'anthropic', 'claude-code', 'succeeded', {
      started: 140,
      ended: 96,
      cost: 1.12,
      verified: true,
    }),
    run('run_0041a', 'FW-C-021', 'worker', 'anthropic', 'claude-code', 'succeeded', {
      started: 190,
      ended: 152,
      cost: 0.84,
      verified: true,
    }),
    run('run_0041b', 'FW-C-021', 'verifier', 'openai', 'codex', 'succeeded', {
      started: 150,
      ended: 141,
      cost: 0.19,
      verified: true,
    }),
    run('run_0039a', 'FW-C-019', 'worker', 'anthropic', 'claude-code', 'succeeded', {
      started: 60 * 9,
      ended: 60 * 8,
      cost: 1.31,
      verified: true,
    }),
    run('run_0038a', 'WS-P0-043', 'worker', 'openai', 'codex', 'succeeded', {
      started: 60 * 10,
      ended: 60 * 9.5,
      cost: 0.44,
    }),
    run('run_0037a', 'FW-C-016', 'worker', 'anthropic', 'claude-code', 'failed', {
      started: 60 * 11,
      ended: 60 * 10.6,
      cost: 0.38,
      failure: 'nonzero_exit',
      exit: 1,
    }),
    run('run_0036a', 'FW-C-006', 'worker', 'anthropic', 'claude-code', 'failed', {
      started: 60 * 12,
      ended: 60 * 11.7,
      cost: 0.29,
      failure: 'claim_mismatch',
      exit: 0,
    }),
    run('run_0035a', 'WS-P1-015', 'worker', 'openai', 'codex', 'killed', {
      started: 60 * 13,
      ended: 60 * 12.9,
      cost: 0.07,
    }),
    run('run_0034a', 'FW-C-013', 'worker', 'anthropic', 'claude-code', 'timed_out', {
      started: 60 * 14,
      ended: 60 * 13,
      cost: 0.9,
    }),
    run('run_0033a', 'WS-P1-024', 'worker', 'anthropic', 'claude-code', 'running', {
      started: 60 * 2,
      cost: 0.55,
      heartbeat: 47,
    }),
  ];

  const cards = [
    {
      id: 'dcd_pr41',
      variant: 'approve',
      project_id: 'prj_flowweb',
      project_name: 'FlowWeb Core',
      row_code: 'FW-C-021',
      asked_by: 'verifier',
      title: 'Merge PR 41: decision-card inbox',
      ask: 'Approve merging PR 41 into main?',
      urgency: 'today',
      deadline_at: ahead(60 * 3),
      default_on_timeout: 'deny',
      approval_id: 'apr_pr41',
      evidence_bundle_id: 'evb_pr41',
      body: {
        headline: 'Merge PR 41 into main: decision-card inbox.',
        payload_preview: {
          format: 'diff',
          full_ref: 'fw://evidence/evb_pr41/diff',
          payload_hash: sha(DIFF_PR41),
        },
        risk: {
          blast_radius: '3 files, packages/web',
          reversible: true,
          rollback_tested: false,
          scan_status: 'green',
        },
      },
      status: 'open',
      answer: null,
      answered_by: null,
      answered_at: null,
      created_at: ago(64),
    },
    {
      id: 'dcd_pr43',
      variant: 'approve',
      project_id: 'prj_flowweb',
      project_name: 'FlowWeb Core',
      row_code: 'FW-C-022',
      asked_by: 'verifier',
      title: 'Merge PR 43: evidence view',
      ask: 'Approve merging PR 43 into main?',
      urgency: 'today',
      deadline_at: ahead(60 * 5),
      default_on_timeout: 'deny',
      approval_id: 'apr_pr43',
      evidence_bundle_id: 'evb_pr43',
      body: {
        headline: 'Merge PR 43 into main: evidence view.',
        payload_preview: {
          format: 'diff',
          full_ref: 'fw://evidence/evb_pr43/diff',
          payload_hash: sha(DIFF_PR43),
        },
        risk: {
          blast_radius: '2 files, packages/web',
          reversible: true,
          rollback_tested: false,
          scan_status: 'warn',
        },
      },
      status: 'open',
      answer: null,
      answered_by: null,
      answered_at: null,
      created_at: ago(38),
    },
    {
      id: 'dcd_choose1',
      variant: 'choose',
      project_id: 'prj_flowweb',
      project_name: 'FlowWeb Core',
      row_code: 'WS-P1-008',
      asked_by: 'chief_of_staff',
      title: 'Pick the sandbox for Codex runs',
      ask: 'Which sandbox should Codex runs use until containers ship?',
      urgency: 'this_week',
      deadline_at: null,
      default_on_timeout: 'Keep runs paused',
      approval_id: null,
      evidence_bundle_id: null,
      body: {
        options: [
          {
            id: 'opt_worktree',
            label: 'Worktree with egress allowlist',
            consequence: 'Runs resume today; egress is best effort on macOS.',
            cost_usd: 0,
            reversible: true,
          },
          {
            id: 'opt_container',
            label: 'Wait for the container flag',
            consequence: 'Codex rows stay paused about 3 days.',
            cost_usd: 0,
            reversible: true,
          },
          {
            id: 'opt_claude_only',
            label: 'Route those rows to Claude',
            consequence: 'No cross-vendor verifier for them until containers ship.',
            cost_usd: 2.4,
            reversible: true,
          },
        ],
        recommended_option: 'opt_worktree',
        recommendation_reason: 'Unblocks 4 rows now, and every option can be undone.',
      },
      status: 'open',
      answer: null,
      answered_by: null,
      answered_at: null,
      created_at: ago(60 * 5),
    },
    {
      id: 'dcd_answer1',
      variant: 'answer',
      project_id: 'prj_flowweb',
      project_name: 'FlowWeb Core',
      row_code: 'FW-C-028',
      asked_by: 'worker',
      title: 'Where should out-of-band alerts go?',
      ask: 'Which webhook URL should fwd call when the kill switch trips?',
      urgency: 'whenever',
      deadline_at: null,
      default_on_timeout: 'No webhook; alerts stay in the UI',
      approval_id: null,
      evidence_bundle_id: null,
      body: {
        question: 'Which webhook URL should fwd call when the kill switch trips or the breaker fires?',
        answer_type: 'text',
        constraints: { max_length: 300 },
        suggested_answer: 'None for now',
        basis_gap: 'Only you know which channel you watch outside the app.',
      },
      status: 'open',
      answer: null,
      answered_by: null,
      answered_at: null,
      created_at: ago(60 * 20),
    },
    {
      id: 'dcd_unblock1',
      variant: 'unblock',
      project_id: 'prj_flowweb',
      project_name: 'FlowWeb Core',
      row_code: 'WS-P1-015',
      asked_by: 'system',
      title: 'Codex adapter needs an API key',
      ask: 'Add a Codex-scoped key, or park the row.',
      urgency: 'this_week',
      deadline_at: null,
      default_on_timeout: 'Row stays blocked',
      approval_id: null,
      evidence_bundle_id: null,
      body: {
        blocker: {
          kind: 'missing_access',
          description: 'No credential handle for the openai vendor with the Codex scope.',
          since: ago(60 * 26),
        },
        suggested_actions: [
          {
            id: 'act_added',
            label: 'I added the key',
            consequence: 'fwd re-checks the credential and requeues the row.',
          },
          { id: 'act_park', label: 'Park the row', consequence: 'The row moves to Parked; nothing runs.' },
        ],
      },
      status: 'open',
      answer: null,
      answered_by: null,
      answered_at: null,
      created_at: ago(60 * 26),
    },
  ];

  const approvals = {
    apr_pr41: {
      id: 'apr_pr41',
      tier: 'L3',
      subject_kind: 'pull_request',
      subject_ref: 'hellofrequencylab/flowweb#41',
      payload_hash: sha(DIFF_PR41),
      head_sha: git('pr41-head'),
      evidence_bundle_id: 'evb_pr41',
      status: 'pending',
      expires_at: ahead(60 * 3),
      default_on_timeout: 'deny',
      decision: null,
      responded_at: null,
      current_head_sha: git('pr41-head'),
      merge_slot: { held: true, expires_at: ahead(25) },
      cost_usd: 0.84,
      files: [
        { path: 'packages/web/src/table/Queue.tsx', added: 14, removed: 0 },
        { path: 'packages/web/src/table/Card.tsx', added: 4, removed: 2 },
        { path: 'packages/web/test/table.test.tsx', added: 7, removed: 0 },
      ],
    },
    apr_pr43: {
      id: 'apr_pr43',
      tier: 'L3',
      subject_kind: 'pull_request',
      subject_ref: 'hellofrequencylab/flowweb#43',
      payload_hash: sha(DIFF_PR43),
      head_sha: git('pr43-head'),
      evidence_bundle_id: 'evb_pr43',
      status: 'pending',
      expires_at: ahead(60 * 5),
      default_on_timeout: 'deny',
      decision: null,
      responded_at: null,
      current_head_sha: git('pr43-head'),
      merge_slot: { held: false },
      cost_usd: 1.12,
      files: [
        { path: 'packages/web/src/evidence/Evidence.tsx', added: 6, removed: 0 },
        { path: 'packages/web/test/evidence.test.tsx', added: 0, removed: 4 },
      ],
    },
  };

  const evidence = {
    evb_pr41: bundle('evb_pr41', 'hellofrequencylab/flowweb#41', git('pr41-head'), DIFF_PR41, {
      scan_red: 0,
      checks: [
        ['Tests', 'tests', 'pass', '212 passed'],
        ['Typecheck', 'typecheck', 'pass', '0 errors'],
        ['Lint', 'lint', 'skipped', 'Lint config missing on branch'],
        ['Probe ui/captains-table', 'custom', 'pass', 'exit 0 on branch'],
        ['Diff policy', 'custom', 'pass', 'Only packages/web/src/table/ touched'],
        ['Secret scan', 'secret_scan', 'pass', 'gitleaks: 0 findings'],
      ],
      verdict: {
        vendor: 'openai',
        verdict: 'concur',
        summary: "Matches the row's acceptance list. Approve lock is tested.",
        same_vendor_review: false,
      },
      files: approvals.apr_pr41.files,
      removed: [],
      probe: {
        exit_code: 0,
        output_tail:
          'PASS ui/captains-table\n  ✓ empty state only on confirmed zero (41 ms)\n  ✓ stale head shows changed state (63 ms)\n  ✓ approve posts payload_hash and head_sha (52 ms)\n3 passed, 0 failed',
        duration_ms: 4120,
      },
      cost: 0.84,
      sandbox: 'enforced',
    }),
    evb_pr43: bundle('evb_pr43', 'hellofrequencylab/flowweb#43', git('pr43-head'), DIFF_PR43, {
      scan_red: 1,
      checks: [
        ['Tests', 'tests', 'pass', '208 passed'],
        ['Typecheck', 'typecheck', 'pass', '0 errors'],
        ['Lint', 'lint', 'warn', '2 warnings'],
        ['Probe ui/evidence-view', 'custom', 'fail', 'exit 1: diff view missing'],
        ['Diff policy', 'custom', 'warn', 'A test file was deleted'],
        ['Secret scan', 'secret_scan', 'fail', 'gitleaks: 1 finding (GitHub token pattern)'],
      ],
      verdict: {
        vendor: 'anthropic',
        verdict: 'concerns',
        summary: 'A test was removed without replacement.',
        same_vendor_review: true,
      },
      files: approvals.apr_pr43.files,
      removed: ['packages/web/test/evidence.test.tsx: renders the checklist (deleted)'],
      probe: {
        exit_code: 1,
        output_tail:
          'FAIL ui/evidence-view\n  ✕ diff view shows the exact hunks (12 ms)\n    Expected element [data-diff] to exist\n1 passed, 1 failed',
        duration_ms: 3890,
      },
      cost: 1.12,
      sandbox: 'best_effort',
    }),
    evb_pr39: bundle('evb_pr39', 'hellofrequencylab/flowweb#39', git('pr39-head'), '', {
      scan_red: 0,
      checks: [
        ['Tests', 'tests', 'pass', '190 passed'],
        ['Secret scan', 'secret_scan', 'pass', '0 findings'],
      ],
      verdict: { vendor: 'openai', verdict: 'concur', summary: 'Fine.', same_vendor_review: false },
      files: [],
      removed: [],
      probe: null,
      cost: 1.31,
      sandbox: 'enforced',
    }),
  };
  const diffs = { evb_pr41: DIFF_PR41, evb_pr43: DIFF_PR43, evb_pr39: '' };

  const s = {
    scenario,
    down: false,
    pairedAt: ago(60 * 24 * 3),
    kill: {
      engaged: false,
      engaged_at: null,
      reason: null,
      runs_to_halt: 0,
      runs_halted: 0,
      keys_revoked: false,
    },
    chain: { ok: true, failed_seq: null },
    spendToday: 4.2,
    cap: 15,
    vendorsReporting: ['anthropic', 'openai'],
    breaker: { tripped: false, reason: null },
    pausedByBudget: false,
    sandbox: 'enforced',
    rows,
    runs,
    cards,
    approvals,
    evidence,
    diffs,
    digest: {
      id: 'rpt_daily_1109',
      kind: 'daily',
      period_from: ago(60 * 24),
      period_to: ago(60 * 3),
      data_as_of: ago(60 * 3),
      created_at: ago(60 * 3),
      body: {
        self_check: { passed: true, failed_query_ids: [] },
        headline: '4 rows done since yesterday. 5 cards need you. Spend $4.20 of $15.',
        done: [],
        blocked: [],
      },
    },
  };

  switch (scenario) {
    case 'quiet':
      s.cards = [];
      s.runs = s.runs
        .filter((r) => !['running', 'queued', 'validating'].includes(r.status))
        .map((r) => ({ ...r, ended_at: ago(60 * 30) }));
      s.rows = s.rows.map((r) => ({
        ...r,
        closed_at: r.closed_at ? ago(60 * 30) : null,
        updated_at: ago(60 * 30),
        status: r.status === 'watching' ? 'done' : r.status,
      }));
      s.spendToday = 0;
      s.digest.body.headline = 'Nothing changed since 06:00.';
      break;
    case 'stopped':
      s.kill = {
        engaged: true,
        engaged_at: ago(7),
        reason: 'Stopped from the web UI',
        runs_to_halt: 9,
        runs_halted: 9,
        keys_revoked: true,
      };
      s.runs = s.runs.map((r) =>
        ['running', 'queued', 'validating'].includes(r.status)
          ? { ...r, status: 'killed', ended_at: ago(7) }
          : r,
      );
      break;
    case 'down':
      s.down = true;
      break;
    case 'integrity':
      s.chain = { ok: false, failed_seq: 18231 };
      break;
    case 'budget':
      s.spendToday = 15;
      s.pausedByBudget = true;
      s.breaker = { tripped: true, reason: 'Daily fleet cap of $15.00 reached' };
      s.vendorsReporting = ['anthropic'];
      break;
    case 'stale-card':
      s.approvals.apr_pr41.current_head_sha = git('pr41-head-v2');
      break;
    case 'digest-failed':
      s.digest.body.self_check = { passed: false, failed_query_ids: ['q_runs_24h'] };
      break;
    case 'no-digest':
      s.digest = null;
      break;
    case 'egress':
      s.sandbox = 'best_effort';
      break;
  }
  return s;

  function run(id, code, role, vendor, adapter, status, o) {
    return {
      id,
      work_order_id: `wo_${id.slice(4)}`,
      project_id: 'prj_flowweb',
      stream_id: 'str_dev',
      ledger_row_id: lr(code),
      row_code: code,
      agent_role: role,
      agent_id: `agt_${role}_${vendor}`,
      adapter_name: adapter,
      adapter_vendor: vendor,
      adapter_version: adapter === 'codex' ? '0.58.0' : '2.4.1',
      model: adapter === 'codex' ? 'gpt-5.5-codex' : 'claude-sonnet-5-5',
      status,
      exit_code: o.exit ?? (status === 'succeeded' ? 0 : null),
      failure_class:
        o.failure ?? (status === 'timed_out' ? 'timeout' : status === 'killed' ? 'killed' : null),
      cost_usd: o.cost,
      cost_estimated: Boolean(o.estimated),
      tokens_in: Math.round(o.cost * 180_000),
      tokens_out: Math.round(o.cost * 22_000),
      turns: Math.round(o.cost * 30),
      started_at: o.started === null ? null : ago(o.started),
      ended_at: o.ended === undefined ? null : ago(o.ended),
      queued_at: ago((o.started ?? 2) + 1),
      sandbox_level: vendor === 'openai' ? 'best_effort' : 'enforced',
      heartbeatMin: o.heartbeat,
      artifact_verified: Boolean(o.verified),
      branch: `fw/${code.toLowerCase()}`,
      artifacts:
        status === 'succeeded'
          ? [
              {
                kind: 'pull_request',
                ref: `https://github.com/hellofrequencylab/flowweb/pull/${id.slice(6, 8)}`,
                sha: git(id),
                claimed_by_agent: true,
                verified_by_kernel: Boolean(o.verified),
                verified_at: o.verified ? ago(o.ended - 1) : null,
              },
            ]
          : [],
      result:
        status === 'succeeded' || status === 'failed'
          ? {
              summary:
                o.failure === 'claim_mismatch'
                  ? 'Agent said the probe passes; the kernel found no matching commit.'
                  : `Implemented ${code}.`,
              claims: [
                { claim: 'All acceptance items are met.' },
                { claim: 'Added tests for the new behaviour.', evidence_ref: 'packages/web/test/' },
              ],
            }
          : null,
      verifier:
        id === 'run_0041a'
          ? {
              verdict: 'concur',
              vendor: 'openai',
              summary: 'Matches acceptance; lock is tested.',
              same_vendor_review: false,
            }
          : id === 'run_0043a'
            ? {
                verdict: 'concerns',
                vendor: 'anthropic',
                summary: 'A test was removed.',
                same_vendor_review: true,
              }
            : null,
    };
  }

  function bundle(id, ref, head, diff, o) {
    return {
      id,
      subject_kind: 'pull_request',
      subject_ref: ref,
      subject_sha: head,
      bundle_hash: sha(`bundle:${id}`),
      scan_red: o.scan_red,
      captured_by: 'ci_sandbox',
      created_at: ago(60),
      body: {
        intent_payload: { rendered_ref: `fw://evidence/${id}/diff`, payload_hash: sha(diff), format: 'diff' },
        automated_evidence: o.checks.map(([name, kind, status, summary], i) => ({
          name,
          kind,
          status,
          summary,
          ran_at: ago(50 - i),
          artifact_ref: `fw://ci/${id}/${kind}`,
        })),
        visual_evidence: [],
        blast_radius: {
          summary: `${o.files.length} files in packages/web. UI only; the kernel is untouched.`,
          affected: o.files.map((f) => f.path),
          reversible: true,
          rollback_plan: 'Revert the merge commit; no data migrations.',
          rollback_tested: false,
        },
        independent_check: {
          reviewer_agent_id: `agt_verifier_${o.verdict.vendor}`,
          vendor: o.verdict.vendor,
          verdict: o.verdict.verdict,
          same_vendor_review: o.verdict.same_vendor_review,
          advisory: true,
        },
        cost_estimate_usd: o.cost,
        not_verified: o.checks.filter((c) => c[2] === 'skipped').map((c) => c[0]),
      },
      view: {
        probe: o.probe,
        diff: { hash: sha(diff), files: o.files },
        policy: [{ rule: 'pol_merge_main', verdict: 'ask', detail: 'L3' }],
        sandbox: {
          level: o.sandbox,
          controls:
            o.sandbox === 'enforced'
              ? ['egress allowlist', 'read-only home', 'no docker socket']
              : ['egress allowlist (best effort on macOS)'],
        },
        adapter: { name: 'claude-code', version: '2.4.1', help_sha256: sha('help') },
        tests_removed_or_skipped: o.removed,
        tokens: { input: Math.round(o.cost * 180_000), output: Math.round(o.cost * 22_000), estimated: true },
        verifier_summary: o.verdict.summary,
      },
    };
  }
}

state = initialState(arg('--scenario', 'normal'));
for (let i = 0; i < 6; i++) emit('system.started', { summary: 'fwd started' });

/* ---------------- HTTP ---------------- */

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}
const envelope = (data) => ({ data, as_of: new Date().toISOString(), head_seq: seq, next_cursor: null });
const err = (res, code, ecode, message) => send(res, code, { error: { code: ecode, message, details: {} } });
const _PROPOSED = { 'x-mock-proposed': '1' };

function cookie(req) {
  const m = /(?:^|;\s*)fw_session=([^;]+)/.exec(req.headers.cookie ?? '');
  return m ? m[1] : null;
}

async function body(req) {
  let b = '';
  for await (const c of req) b += c;
  try {
    return b ? JSON.parse(b) : {};
  } catch {
    return null;
  }
}

function runView(r) {
  const { heartbeatMin, ...rest } = r;
  return {
    ...rest,
    last_heartbeat_at: r.status === 'running' && heartbeatMin !== undefined ? ago(heartbeatMin) : null,
  };
}

function cardDetail(c) {
  const a = c.approval_id ? state.approvals[c.approval_id] : null;
  const pr = a ? Number(a.subject_ref.split('#')[1]) : null;
  return {
    ...c,
    snoozed_until: c.snoozed_until ?? null,
    approval: a
      ? { payload_hash: a.payload_hash, head_sha: a.head_sha, expires_at: a.expires_at, status: a.status }
      : null,
    pr: a
      ? {
          url: `https://github.com/hellofrequencylab/flowweb/pull/${pr}`,
          number: pr,
          current_head_sha: a.current_head_sha,
          head_observed_at: ago(1),
        }
      : null,
    merge_slot: a ? a.merge_slot : null,
    policy: a
      ? {
          rule_id: 'pol_merge_main',
          rule_version: 3,
          reason: 'Merges into main need the Owner at L3 (act with approval).',
          tier: a.tier,
        }
      : {
          rule_id: 'pol_owner_questions',
          rule_version: 1,
          reason: 'Only the Owner can answer questions about intent or access.',
          tier: 'L2',
        },
    files: a ? a.files : [],
    cost_usd: a ? a.cost_usd : null,
    superseded_by_card_id: null,
  };
}

function statusView() {
  const open = state.cards.filter((c) => c.status === 'open');
  return {
    daemon: 'up',
    version: '0.1.0-mock',
    started_at: new Date(T0).toISOString(),
    kill: state.kill,
    chain: {
      ok: state.chain.ok,
      head_seq: seq,
      head_hash: events[events.length - 1].hash,
      verified_at: ago(60 * 3),
      failed_seq: state.chain.failed_seq,
    },
    spend: {
      today_usd: state.spendToday,
      daily_cap_usd: state.cap,
      vendors_reporting: state.vendorsReporting,
      vendors_configured: ['anthropic', 'openai'],
      estimated: true,
    },
    breaker: state.breaker,
    paused_by_budget: state.pausedByBudget,
    sandbox_level: state.sandbox,
    open_cards: open.length,
    running_runs: state.runs.filter((r) => r.status === 'running').length,
    oldest_open_card_at: open.map((c) => c.created_at).sort()[0] ?? null,
  };
}

function spendGroups(groupBy, from, to) {
  // Deterministic fake spend: today from state, earlier days a fixed pattern.
  const f = Date.parse(from ?? ago(60 * 24 * 7));
  const t = Date.parse(to ?? new Date().toISOString());
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  let total = 0;
  const pattern = [6.1, 8.4, 3.2, 11.9, 7.5, 9.8];
  for (let d = 1; d <= 6; d++) {
    const dayStart = startOfToday.getTime() - d * 86_400_000;
    if (dayStart >= f && dayStart < t) total += pattern[d - 1];
  }
  if (t > startOfToday.getTime()) total += state.spendToday;
  total = Math.round(total * 100) / 100;
  const groups =
    groupBy === 'vendor'
      ? state.vendorsReporting.length === 2
        ? [
            {
              key: 'anthropic',
              label: 'anthropic',
              usd: Math.round(total * 0.68 * 100) / 100,
              tokens_in: 0,
              tokens_out: 0,
            },
            {
              key: 'openai',
              label: 'openai',
              usd: Math.round(total * 0.32 * 100) / 100,
              tokens_in: 0,
              tokens_out: 0,
            },
          ]
        : [{ key: 'anthropic', label: 'anthropic', usd: total, tokens_in: 0, tokens_out: 0 }]
      : [{ key: 'prj_flowweb', label: 'FlowWeb Core', usd: total, tokens_in: 0, tokens_out: 0 }];
  return {
    group_by: groupBy,
    from,
    to,
    groups,
    total_usd: total,
    vendors_reporting: state.vendorsReporting.length,
    vendors_total: 2,
  };
}

const MOCK_PAGE = () => `<!doctype html><meta charset="utf-8"><title>Mock fwd</title>
<style>body{font:15px system-ui;margin:24px;max-width:640px}button{margin:4px;padding:8px 12px;font:inherit}</style>
<h1>Mock fwd</h1><p>Scenario: <b>${state.scenario}</b>. Pairing code: <code>${PAIR_CODE}</code>. Auth: ${NO_AUTH ? 'off' : 'on'}.</p>
<p>${[
  'normal',
  'quiet',
  'stopped',
  'down',
  'integrity',
  'budget',
  'stale-card',
  'digest-failed',
  'no-digest',
  'egress',
]
  .map(
    (n) =>
      `<button onclick="fetch('/__mock/scenario?name=${n}',{method:'POST'}).then(()=>location.reload())">${n}</button>`,
  )
  .join('')}</p>
<p><button onclick="fetch('/__mock/event',{method:'POST'}).then(()=>location.reload())">Emit a run event</button>
<button onclick="fetch('/__mock/push-head',{method:'POST'}).then(()=>location.reload())">Agent pushes new head on PR 41</button>
<button onclick="fetch('/__mock/unpair',{method:'POST'}).then(()=>location.reload())">Forget paired browsers</button></p>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const q = url.searchParams;

  // Mock controls (never part of fwd).
  if (p === '/__mock' || p === '/__mock/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(MOCK_PAGE());
  }
  if (p === '/__mock/scenario' && req.method === 'POST') {
    state = initialState(q.get('name') ?? 'normal');
    emit('system.started', { summary: `mock scenario ${state.scenario}` });
    return send(res, 200, { scenario: state.scenario });
  }
  if (p === '/__mock/event' && req.method === 'POST') {
    emit('run.started', { summary: 'mock run event' });
    return send(res, 200, { ok: true });
  }
  if (p === '/__mock/push-head' && req.method === 'POST') {
    state.approvals.apr_pr41.current_head_sha = git(`pr41-head-${Date.now()}`);
    emit('evidence.bundle_created', { summary: 'Agent pushed to PR 41' });
    return send(res, 200, { ok: true });
  }
  if (p === '/__mock/unpair' && req.method === 'POST') {
    sessions.clear();
    return send(res, 200, { ok: true });
  }

  if (!p.startsWith('/v1/')) return err(res, 404, 'not_found', 'Not found');
  if (state.down) {
    res.writeHead(503);
    return res.end();
  }

  // Loopback-only Origin check, as fwd does.
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin))
    return err(res, 403, 'forbidden', 'Origin not allowed');

  const route = p.slice(3); // drop /v1

  if (route === '/pair' && req.method === 'POST') {
    const b = await body(req);
    if (!b || String(b.code).trim() !== PAIR_CODE)
      return err(res, 401, 'pairing_failed', 'That code did not match.');
    const token = randomBytes(16).toString('hex');
    sessions.add(token);
    state.pairedAt = new Date().toISOString();
    return send(res, 200, envelope({ paired_at: state.pairedAt, device_label: 'This browser' }), {
      'Set-Cookie': `fw_session=${token}; HttpOnly; SameSite=Strict; Path=/`,
    });
  }

  if (!NO_AUTH && !sessions.has(cookie(req)))
    return err(res, 401, 'unauthorized', 'Pair this browser first.');

  if (route === '/events/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    const last = Number(req.headers['last-event-id'] ?? 0);
    if (last)
      for (const e of events.filter((x) => x.seq > last))
        res.write(`id: ${e.seq}\nevent: fw\ndata: ${JSON.stringify(e)}\n\n`);
    res.write(': connected\n\n');
    sseClients.add(res);
    const hb = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(hb);
      sseClients.delete(res);
    });
    return;
  }

  if (req.method === 'GET') {
    let m;
    const at = (re) => {
      m = re.exec(route);
      return m;
    };
    if (route === '/session')
      return send(res, 200, envelope({ paired_at: state.pairedAt, device_label: 'This browser' }));
    if (route === '/status') return send(res, 200, envelope(statusView()));
    if (route === '/status-reports') return send(res, 200, envelope(state.digest ? [state.digest] : []));
    if (route === '/supervisor') return send(res, 200, envelope(supervisorFixture));
    if (route === '/flows/local-saturation') return send(res, 200, envelope(flowFixture));
    if (route === '/flows/neighborhood-activation') return send(res, 200, envelope(activationFixture));
    if (route === '/flows/paid-ads') return send(res, 200, envelope(adsFixture));
    if (route === '/policy')
      return send(
        res,
        200,
        envelope({
          path: 'policy/core-policy.yaml',
          commit: git('policy'),
          sha256: sha('policy'),
          text: POLICY_TEXT,
        }),
      );
    if (route === '/projects') return send(res, 200, envelope([projectView(), ...EXTRA_PROJECTS]));
    if (at(/^\/projects\/([^/]+)$/))
      return m[1] === 'prj_flowweb'
        ? send(res, 200, envelope(projectView()))
        : err(res, 404, 'not_found', 'No such project');
    if (route === '/ledger/rows') {
      let rows = state.rows;
      if (q.get('status')) rows = rows.filter((r) => r.status === q.get('status'));
      return send(res, 200, envelope(rows));
    }
    if (at(/^\/ledger\/rows\/([^/]+)$/)) {
      const r = state.rows.find((x) => x.id === m[1] || x.code === m[1]);
      if (!r) return err(res, 404, 'not_found', 'No such row');
      return send(
        res,
        200,
        envelope({
          ...r,
          evidence: Object.values(state.evidence)
            .filter((e) => e.id === r.evidence_bundle_id)
            .map((e) => ({ id: e.id, created_at: e.created_at, scan_red: e.scan_red })),
          runs: state.runs.filter((x) => x.row_code === r.code).map(runView),
        }),
      );
    }
    if (route === '/runs') {
      let runs = state.runs;
      if (q.get('status')) runs = runs.filter((r) => r.status === q.get('status'));
      if (q.get('row_id')) runs = runs.filter((r) => r.ledger_row_id === q.get('row_id'));
      return send(res, 200, envelope(runs.map(runView)));
    }
    if (at(/^\/runs\/([^/]+)\/steps$/)) {
      const r = state.runs.find((x) => x.id === m[1]);
      if (!r) return err(res, 404, 'not_found', 'No such run');
      return send(res, 200, envelope(stepsFor(r)));
    }
    if (at(/^\/runs\/([^/]+)$/)) {
      const r = state.runs.find((x) => x.id === m[1]);
      return r ? send(res, 200, envelope(runView(r))) : err(res, 404, 'not_found', 'No such run');
    }
    if (at(/^\/evidence-bundles\/([^/]+)\/diff$/)) {
      const d = state.diffs[m[1]];
      if (d === undefined) return err(res, 404, 'not_found', 'No such bundle');
      res.writeHead(200, { 'Content-Type': 'text/x-diff', 'Cache-Control': 'no-store' });
      return res.end(d);
    }
    if (at(/^\/evidence-bundles\/([^/]+)$/)) {
      const e = state.evidence[m[1]];
      return e ? send(res, 200, envelope(e)) : err(res, 404, 'not_found', 'No such bundle');
    }
    if (route === '/events') {
      let ev = events;
      if (q.get('type')) ev = ev.filter((e) => e.type === q.get('type'));
      if (q.get('run_id')) ev = ev.filter((e) => e.run_id === q.get('run_id'));
      if (q.get('after_seq')) ev = ev.filter((e) => e.seq > Number(q.get('after_seq')));
      const extra =
        q.get('type') === 'dispatch.refused_budget' && state.scenario === 'budget'
          ? [
              {
                seq: seq,
                id: 'evt_ref1',
                ts: ago(12),
                type: 'dispatch.refused_budget',
                actor_kind: 'system',
                actor_id: 'fwd',
                project_id: 'prj_flowweb',
                run_id: null,
                payload: {
                  summary: 'FW-C-025 not started: would exceed the daily fleet cap ($15.00) by about $1.80.',
                },
              },
            ]
          : q.get('type') === 'budget.hard_stop'
            ? [
                {
                  seq: seq - 40,
                  id: 'evt_hs1',
                  ts: ago(60 * 13),
                  type: 'budget.hard_stop',
                  actor_kind: 'system',
                  actor_id: 'fwd',
                  project_id: 'prj_flowweb',
                  run_id: 'run_0034a',
                  payload: { summary: 'run_0034a stopped at its $0.90 per-run cap.' },
                },
              ]
            : [];
      return send(res, 200, envelope([...extra, ...ev.slice(-Number(q.get('limit') ?? 50)).reverse()]));
    }
    if (route === '/spend')
      return send(
        res,
        200,
        envelope(spendGroups(q.get('group_by') ?? 'project', q.get('from'), q.get('to'))),
      );
    if (route === '/budgets')
      return send(
        res,
        200,
        envelope([
          {
            id: 'bud_fleet_day',
            scope_kind: 'fleet',
            scope_id: 'fleet',
            period: 'day',
            max_usd: state.cap,
            breaker_daily_usd: state.cap,
            breaker_velocity_usd_per_h: 6,
            spent_usd: state.spendToday,
          },
          {
            id: 'bud_run',
            scope_kind: 'run',
            scope_id: '*',
            period: 'run',
            max_usd: 2,
            breaker_daily_usd: null,
            breaker_velocity_usd_per_h: null,
            spent_usd: 0,
          },
        ]),
      );
    if (route === '/decision-cards') {
      const st = q.get('status');
      return send(res, 200, envelope(state.cards.filter((c) => !st || c.status === st)));
    }
    if (at(/^\/decision-cards\/([^/]+)$/)) {
      const c = state.cards.find((x) => x.id === m[1]) ?? state.answered?.find((x) => x.id === m[1]);
      return c ? send(res, 200, envelope(cardDetail(c))) : err(res, 404, 'not_found', 'No such card');
    }
    if (at(/^\/approvals\/([^/]+)$/)) {
      const a = state.approvals[m[1]];
      return a ? send(res, 200, envelope(a)) : err(res, 404, 'not_found', 'No such approval');
    }
    return err(res, 404, 'not_found', 'No such route');
  }

  if (req.method === 'POST') {
    const b = await body(req);
    if (b === null) return err(res, 400, 'validation_failed', 'Body is not JSON');
    let m;
    const at = (re) => {
      m = re.exec(route);
      return m;
    };
    if (route === '/kill-switch') {
      if (state.kill.engaged) return send(res, 200, envelope(statusView()));
      const live = state.runs.filter((r) =>
        ['running', 'queued', 'validating', 'starting'].includes(r.status),
      );
      state.kill = {
        engaged: true,
        engaged_at: new Date().toISOString(),
        reason: b.reason ?? null,
        runs_to_halt: Math.max(live.length, 1) + 6,
        runs_halted: 0,
        keys_revoked: false,
      };
      emit(
        'system.kill_switch_engaged',
        { summary: 'Kill switch engaged by the Owner', reason: b.reason },
        { actor_kind: 'owner', actor_id: 'own_daniel' },
      );
      const tick = setInterval(() => {
        if (!state.kill.engaged) return clearInterval(tick);
        state.kill.runs_halted += 1;
        if (state.kill.runs_halted >= state.kill.runs_to_halt) {
          state.kill.keys_revoked = true;
          state.runs = state.runs.map((r) =>
            ['running', 'queued', 'validating', 'starting'].includes(r.status)
              ? { ...r, status: 'killed', ended_at: new Date().toISOString() }
              : r,
          );
          clearInterval(tick);
          emit('run.killed', { summary: 'All runs halted; agent keys revoked' });
        } else
          emit('run.killed', { summary: `Halted ${state.kill.runs_halted} of ${state.kill.runs_to_halt}` });
      }, 600);
      return send(res, 202, envelope(statusView()));
    }
    if (route === '/kill-switch/release') {
      state.kill = {
        engaged: false,
        engaged_at: null,
        reason: null,
        runs_to_halt: 0,
        runs_halted: 0,
        keys_revoked: false,
      };
      emit(
        'system.kill_switch_released',
        { summary: 'Released by the Owner. Runs stay paused until started.' },
        { actor_kind: 'owner', actor_id: 'own_daniel' },
      );
      return send(res, 200, envelope(statusView()));
    }
    if (at(/^\/approvals\/([^/]+)\/respond$/)) {
      const a = state.approvals[m[1]];
      if (!a) return err(res, 404, 'not_found', 'No such approval');
      if (state.kill.engaged)
        return err(res, 409, 'kill_switch_engaged', 'Everything is stopped. Release the kill switch first.');
      if (a.status !== 'pending')
        return err(res, 409, 'validation_failed', 'This approval is no longer pending.');
      if (b.decision === 'approved') {
        if (state.evidence[a.evidence_bundle_id]?.scan_red)
          return err(res, 409, 'validation_failed', 'A security scan failed; this cannot be approved.');
        if (
          b.payload_hash !== a.payload_hash ||
          b.head_sha !== a.current_head_sha ||
          a.head_sha !== a.current_head_sha
        )
          return err(res, 409, 'stale_hash', 'The change moved since you looked. Nothing was merged.');
      }
      // A short wait so the "approving" state is visible, as with a real daemon.
      await new Promise((r) => setTimeout(r, 700));
      a.status = b.decision === 'approved' ? 'approved' : 'denied';
      a.decision = b.decision;
      a.responded_at = new Date().toISOString();
      const c = state.cards.find((x) => x.approval_id === a.id);
      if (c) resolveCard(c, { decision: b.decision, reason_code: b.reason_code, comment: b.comment });
      if (b.decision === 'approved') {
        const row = state.rows.find((r) => r.code === c?.row_code);
        if (row) row.status = 'merging';
      }
      emit(
        'approval.responded',
        { summary: `${a.id} ${b.decision}` },
        { actor_kind: 'owner', actor_id: 'own_daniel' },
      );
      return send(res, 200, envelope(a));
    }
    if (at(/^\/decision-cards\/([^/]+)\/answer$/)) {
      const c = state.cards.find((x) => x.id === m[1]);
      if (!c) return err(res, 404, 'not_found', 'No such card');
      if (state.kill.engaged)
        return err(res, 409, 'kill_switch_engaged', 'Everything is stopped. Release the kill switch first.');
      await new Promise((r) => setTimeout(r, 400));
      resolveCard(
        c,
        b.option_id
          ? { decision: 'chosen', option_id: b.option_id }
          : { decision: 'answered', value: b.value },
      );
      emit(
        'decision_card.answered',
        { summary: `${c.id} answered` },
        { actor_kind: 'owner', actor_id: 'own_daniel' },
      );
      return send(res, 200, envelope(cardDetail(c)));
    }
    if (at(/^\/decision-cards\/([^/]+)\/snooze$/)) {
      const c = state.cards.find((x) => x.id === m[1]);
      if (!c) return err(res, 404, 'not_found', 'No such card');
      const a = c.approval_id ? state.approvals[c.approval_id] : null;
      let until = b.until;
      if (a && Date.parse(until) > Date.parse(a.expires_at)) until = a.expires_at;
      c.status = 'snoozed';
      c.snoozed_until = until;
      state.answered = [...(state.answered ?? []), c];
      state.cards = state.cards.filter((x) => x !== c);
      emit(
        'decision_card.snoozed',
        { summary: `${c.id} snoozed until ${until}` },
        { actor_kind: 'owner', actor_id: 'own_daniel' },
      );
      return send(res, 200, envelope(cardDetail(c)));
    }
    return err(res, 404, 'not_found', 'No such route');
  }

  if (req.method === 'DELETE' && route === '/session') {
    sessions.delete(cookie(req));
    res.writeHead(204, { 'Set-Cookie': 'fw_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    return res.end();
  }
  return err(res, 405, 'method_not_allowed', 'Method not allowed');
});

function resolveCard(c, answer) {
  c.status = 'answered';
  c.answer = answer;
  c.answered_by = 'own_daniel';
  c.answered_at = new Date().toISOString();
  state.answered = [...(state.answered ?? []), c];
  state.cards = state.cards.filter((x) => x !== c);
}

// Labelled projects with no rows yet, so the Projects screen has brands and categories to group.
const EXTRA_PROJECTS = [
  {
    id: 'prj_localmkt',
    slug: 'local-marketing',
    name: 'Local marketing engine',
    kind: 'other',
    repo_url: null,
    default_branch: 'main',
    status: 'active',
    wip_limit: 2,
    brand: 'Frequency',
    category: 'marketing',
    rows_open: 0,
    rows_in_progress: 0,
    rows_waiting_on_owner: 0,
    last_run_at: null,
  },
  {
    id: 'prj_sandbox',
    slug: 'sandbox',
    name: 'Sandbox',
    kind: 'repo',
    repo_url: null,
    default_branch: 'main',
    status: 'paused',
    wip_limit: 1,
    brand: null,
    category: null,
    rows_open: 0,
    rows_in_progress: 0,
    rows_waiting_on_owner: 0,
    last_run_at: null,
  },
];

function projectView() {
  return {
    id: 'prj_flowweb',
    slug: 'flowweb',
    name: 'FlowWeb Core',
    kind: 'repo',
    repo_url: 'https://github.com/hellofrequencylab/flowweb',
    default_branch: 'main',
    status: 'active',
    wip_limit: 3,
    brand: 'Frequency',
    category: 'product',
    rows_open: state.rows.filter((r) => ['open', 'ready'].includes(r.status)).length,
    rows_in_progress: state.rows.filter((r) =>
      ['claimed', 'running', 'verifying', 'merging'].includes(r.status),
    ).length,
    rows_waiting_on_owner: state.rows.filter(
      (r) => r.status === 'awaiting_approval' || r.status === 'blocked',
    ).length,
    last_run_at:
      state.runs
        .map((r) => r.started_at)
        .filter(Boolean)
        .sort()
        .pop() ?? null,
  };
}

function stepsFor(r) {
  const t = Date.parse(r.started_at ?? new Date().toISOString());
  const at = (m) => new Date(t + m * 60_000).toISOString();
  const s = [
    [
      'prompt',
      'Work order compiled and sent',
      `Row ${r.row_code}: caps $2.00, 40 turns, 45 min.`,
      null,
      false,
    ],
    [
      'model_turn',
      'Plan',
      '1. Read the row and probe. 2. Edit packages/web/src/table/. 3. Run tests. 4. Open PR.',
      null,
      false,
    ],
    ['tool_call', 'Read packages/web/src/api/types.ts', '', null, false],
    ['tool_result', 'Read 312 lines', 'export type CardVariant = "approve" | "choose" | ...', null, true],
    ['tool_call', 'Edit packages/web/src/table/Card.tsx', '+4 −2', null, false],
    [
      'tool_call',
      'Write .github/workflows/ci.yml',
      '',
      'Write to .github/workflows denied by policy (Tier 0 path).',
      false,
    ],
    ['tool_call', 'Run pnpm -r test', '', null, false],
    ['tool_result', '212 passed', 'Test Files 31 passed (31)\nTests 212 passed (212)', null, true],
    ['checkpoint', 'Open PR', `Pushed branch ${r.branch}; opened pull request.`, null, false],
  ];
  const n = r.status === 'running' ? 6 : s.length;
  return s.slice(0, n).map(([kind, label, excerpt, denied, untrusted], i) => ({
    id: `stp_${r.id.slice(4)}_${i}`,
    run_id: r.id,
    seq: i,
    kind,
    content_ref: `fw://runs/${r.id}/steps/${i}`,
    label,
    excerpt,
    denied_by_policy: denied,
    untrusted,
    cost_usd: Math.round((r.cost_usd / n) * 100) / 100,
    started_at: at(i * 2),
    ended_at: i === n - 1 && r.status === 'running' ? null : at(i * 2 + 1),
  }));
}

const POLICY_TEXT = `# policy/core-policy.yaml (Tier 0, Owner only)
version: 3
budgets:
  fleet_day_usd: 15.00
  per_run_usd: 2.00
  breaker:
    daily_usd: 15.00
    velocity_usd_per_hour: 6.00
rules:
  - id: pol_merge_main
    effect: ask
    tier: L3
    match: { action_class: merge_main }
    reason: Merges into main need the Owner at L3 (act with approval).
  - id: pol_tier0_paths
    effect: deny
    match: { paths: [probes/**, policy/**, config/**, .github/**, CODEOWNERS] }
    reason: Tier 0 paths are Owner only.
  - id: pol_owner_questions
    effect: ask
    tier: L2
    match: { card_variant: [answer, unblock] }
    reason: Only the Owner can answer questions about intent or access.
`;

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `mock fwd on http://127.0.0.1:${PORT}/v1  (scenario: ${state.scenario}, auth: ${NO_AUTH ? 'off' : 'on'}, pairing code ${PAIR_CODE})`,
  );
  console.log(`scenario switcher: http://127.0.0.1:${PORT}/__mock`);
});
