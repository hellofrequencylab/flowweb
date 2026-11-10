# C0 probe pack (Tier 0, DRAFT for Owner review)

Every C0 row of `ledger/backlog/CORE-BACKLOG.json` has a probe here (or, for the three human rows, a
bash script under `scripts/probe-*.sh`). Probes are Tier 0: agents never edit them (AGENTS.md rules 2
and 3; CI job `probe-immutability`). This pack was drafted before the code and has since been
reconciled with the code on the branch (see "Status after reconciliation"). It is still a draft:
the Owner reviews it line by line and commits the final version.

Run one: `pnpm probe c0/<name>` (the runner sets `FW_REPO_ROOT`). Every backlog `verify_probe`
command for a C0 row resolves: `probes/<lane>/<name>.mjs` is a thin wrapper that runs the C0 probe(s)
proving that row.

## Conventions

- Behaviour is tested only through real surfaces: the `fw` CLI (`tsx packages/cli/src/bin.ts`), the
  daemon `fwd` (`tsx packages/daemon/src/bin.ts`), named exports of a package index, and the
  database at `$FW_HOME/db/fw.sqlite`, read with `node:sqlite` read-only. A probe writes to the
  database directly only to play the attacker (tamper tests) or to load a test fixture
  (`fixtures/cost-fixture.sql`).
- Each probe uses a fresh temporary `FW_HOME` and, where a repository is needed, a scratch git repo
  with a local bare remote (`_lib.mjs` `fixtureProject` / `projectFromFiles`). Fixture rows use codes
  `FW-C-9nn` and carry their fake-vendor scenario as a `[fake:<name>]` tag in the title.
  `pipelineHome()` installs `config/core-policy.yaml` (the work-order compiler needs it) and the row
  files live in `<repo>/ledger/rows/` (decision 36).
- Long-running children (`fwd`, a pipeline to be killed) are started with `spawnTs` (one node process
  with tsx as an import hook) and stopped with `killAndWait`, so no forked child is left holding
  `$FW_HOME/fwd.lock`.
- The first output line of a failing probe says `MISSING <probe>: ...` (the surface does not exist)
  or `FAIL <probe>: ...` (it exists and misbehaves). In `.test.ts` probes the text is in vitest's
  error line. A probe checks its open (failing) line last where it can, so every line that holds
  is proven before the first failure stops it.
- `_lib.mjs` holds shared helpers and is not a probe. `fixtures/` holds fixture probes and data used
  by the probes; they are not row probes.
- No secret-shaped literal is stored in this directory: fake secrets are assembled at runtime
  (`fakeSecret()`).

## Probe to row map

| Probe | Row | Backlog `verify_probe` | Acceptance lines it proves |
|---|---|---|---|
| `c0/skeleton` | FW-C-001 | (KICKOFF Prompt 1) | eight `@fw` packages exist and resolve; boundary lint clean; cli -> eventlog import fails the lint |
| `c0/workspace-layout` | FW-C-001 | `pnpm probe devex/workspace-layout` | frozen lockfile satisfies package.json; typecheck with strict, noUncheckedIndexedAccess and exactOptionalPropertyTypes on; `@fw/ledger` -> `@fw/adapters` fails the boundary lint; re-runs `c0/skeleton` |
| `c0/bootstrap` | WS-P0-002 | `node scripts/check-bootstrap.mjs` | CLAUDE.md imports AGENTS.md; CODEOWNERS covers every Tier 0 path; PR template fields |
| `scripts/probe-branch-protection.sh` | WS-P0-003 (human) | `bash scripts/probe-branch-protection.sh` | protection on main, code-owner review, no bypass, agent token has no admin or maintain |
| `c0/ci-skeleton` | WS-P0-004 | `pnpm probe devex/ci-skeleton` | a type error fails CI; an agent PR editing `probes/` fails CI; CI time only with `FW_CI_REPO` and gh; actions pinned by SHA |
| `c0/secret-scan` | WS-P0-005 | `pnpm probe security/secret-scan-fixture` | pre-commit hook blocks a key-shaped string; CI gitleaks job flags it; `.gitleaks.toml` exists and is Tier 0 |
| `c0/probe-runner` | WS-P0-006 | `pnpm probe devex/probe-runner` | missing target exits nonzero; missing probe file exits 2; default 60 s limit. Takes up to 150 s while the limit is missing. |
| `c0/contracts` | FW-C-002 | `pnpm probe kernel/contracts-core` | 17 schemas compile, 17 valid examples pass, 4 invalid rejected (`validate($id, value)`); `contracts-core/SCHEMA-SNAPSHOT.sha256` catches an edit and CI runs it; generated types committed, `gen-types --check` clean, a schema edit drifts them, `pnpm test` runs the check in CI |
| `c0/schema-core` | FW-C-003 | `pnpm probe kernel/schema-core` | store applies exactly schema.core.sql and records its sha256; WAL; foreign_keys on; a changed recorded hash is refused |
| `c0/event-chain` | FW-C-004 | `pnpm probe kernel/event-writer` | 1,000 events verify (store and independent recompute, null optional fields omitted, anchored to contract example 20); flipped byte reported by seq; delete and update refused; idempotent append; secret redacted and `_redacted` recorded; second writer gets a typed lock error |
| `c0/ledger-sync` | FW-C-005 | `pnpm probe kernel/ledger-sync` | every row file imports as open with one `ledger.row_created` each; second sync idempotent; a changed probe is refused (exit 1, row named), ledger_rows untouched, a tamper event recorded; status never imported; sync never writes row files |
| `c0/cli-skeleton` | FW-C-006 | `pnpm probe cli/skeleton` | every listed command takes `--json` and prints one JSON document; help lists only implemented commands; exit 2 usage, 4 locked writer (a real `fwd` holds the lock), 3 policy refusal; `--home` overrides `FW_HOME` |
| `c0/ledger-fsm` | WS-P0-016 | `pnpm probe kernel/ledger-fsm` | illegal transitions refused with no change; legal ones emit `ledger.row_status_changed`. done -> regressed is proven by `c0/run-fake-e2e`. |
| `c0/probe-exec` | WS-P0-019 | `pnpm probe kernel/probe-exec` | over-timeout probe killed (whole group) and recorded fail; stored probe definition tampered: refused, `audit.finding_raised`; probe file differing from `probes/MANIFEST.sha256`: refused with `tamper_detected`; `ledger.probe_executed` has stdout tail, exit code, duration |
| `c0/premise-retest` | WS-P0-020 | `pnpm probe kernel/premise-retest` | `fw ledger retest`: a row whose probe already passes is parked, never ready; `ledger.row_premise_retested` records each result; a failing probe makes the row ready; issue and run refuse a parked row |
| `c0/ledger-commands` | WS-P0-021 | `pnpm probe cli/ledger-commands` | list, list --lane, show, next (exactly the one ready row whose deps are done), close `--merged-sha` refused while the probe fails, all `--json` |
| `c0/audit-chain` | WS-P0-023 | `pnpm probe security/audit-chain` | flipped byte: `fw audit verify` fails naming the seq; 100k events verify in under 5 s; `fw audit verify --json` exports the head hash and count |
| `c0/cost-record` | WS-P0-025 | `pnpm probe kernel/cost-record` | a fake run's `fw run show` cost equals the SQL sum; fixture rollup per run; missing cost is unknown, never 0; `GET /v1/spend?group_by=agent` equals the SQL sums; `fw spend --by agent` prints the rollup |
| `c0/adapter-contract-types` | WS-P0-026 | `pnpm probe adapters/contract-types` | SDK names no vendor beyond the `Vendor` union mirrored from common.json and imports only SDK-local and `node:` modules; every registered adapter implements start, fingerprint, preflight and the three capability booleans; a no-op reference adapter exists |
| `c0/fake-adapter` | FW-C-007 | `pnpm probe adapters/fake-vendor` | the nine scenarios selected by title tag give their expected status; no network, no keys; fabricated claim is a `claimed` PR with no commit; injection flagged in `injection_suspected`; no secret emitted; hang leaves no process; forbidden_path lists CODEOWNERS and probes/ |
| `c0/adapter-contract` | WS-P0-027 | `pnpm probe adapters/conformance-suite` | the suite (`packages/adapters/test/conformance.ts`) passes all 8 cases for the fake; eight broken fakes each fail exactly their case; no network or keys |
| `c0/supervisor-caps` | WS-P0-028 | `pnpm probe runtime/supervisor-caps` | hang killed within 2 s of the cap; `cap_breach` names wall_clock, usd or tokens, and turns; no group member and no process in the workspace left |
| `c0/credential-handle` | WS-P0-029 | `pnpm probe security/credential-handle` | handle resolves from the 0600 file; missing secret gives a typed error naming handle and fix; 0644 file refused. Not in argv: `c0/orphan-recovery`; not in run files: `c0/run-fake-e2e`. |
| `c0/claude-conformance` | WS-P0-030 | `pnpm probe adapters/claude-conformance` | the conformance suite passes against the recorded-CLI fixtures; preflight fails closed on a missing flag and never runs a prompt; fingerprint = version + sha256(help); OAuth, auth-token and missing credentials refused before the CLI runs; a second run resumes the session (`--resume <id>`, same session id) |
| `c0/worktree-manager` | WS-P0-032 | `pnpm probe runtime/worktree-manager` | same run and same row refused (decision 13); removal leaves no git metadata; path outside the checkout under `$FW_HOME/worktrees`; branch `fw/<row>/<run>` |
| `c0/sandbox-selftest` | FW-C-008 | `pnpm probe runtime/sandbox-userdir` | child env is exactly the sandbox env with HOME = `$FW_HOME/runs/<run>/home`; every control graded and honest (process group, egress, env scrub); `fw doctor` shows the levels; `fw gc` removes the run dir and keeps the branch |
| `c0/diff-policy` | WS-P0-035 | `pnpm probe policy/diff-policy` | clean fixture passes; forbidden path named (`tier0_path`); outside-scope path named; deleted_test, skipped_test, config_relaxation, size_over_cap, new_dependency each named; rules in `policy/rules/diff-policy.json` |
| `c0/git-edge` | WS-P0-036 | `pnpm probe adapters/git-edge` | local bare host: push and PR return URL and head SHA, status re-fetched; `GhHost` with a stub gh: admin scope and repo admin refused, narrow token passes; 429 and 502 retried with growing delay and logged |
| `c0/evidence-builder` | WS-P0-038 | `pnpm probe kernel/evidence-builder` | diff bound by `intent_payload` (rendered_ref + sha256 of the bytes, decision 29); every member changes the hash; same input same hash; schema-valid; PR comment carries bundle and diff hash |
| `c0/artifact-required` | WS-P0-039 | `pnpm probe kernel/artifact-required` | a fabricated PR claim fails the run (`claim_mismatch` or `no_artifact`), no kernel-verified artifact, `run.claim_mismatch`, one `run.failed`, row not advanced, no PR on the host |
| `c0/wo-issue` | WS-P0-040 | `pnpm probe kernel/work-order-compile` | work order validates (python jsonschema); no files_hint gives the restrictive `docs/notes/<code>/**`; deterministic content hash; touches, acceptance and caps from row and policy; self-verify and unready rows refused; XL exit 3 |
| `c0/run-fake-e2e` | WS-P0-041 | `pnpm probe e2e/walking-skeleton-fake` | full loop on `fw/<row>/<run>`: verified PR at the remote head, `fw-fake/<run>.md`, session id stored, bundle bound to the head with the literal diff file, spend, status events, PR comment with the hash, worktree removed; failure path keeps the worktree (registered) and returns the row to ready; close `--merged-sha` gives done; done -> regressed; audit clean; no secret leak |
| `c0/diff-policy-run` | WS-P0-041 | `pnpm probe e2e/walking-skeleton-fake` | a run touching CODEOWNERS and probes/ fails naming the diff policy; branch renamed `fw/quarantine/<run>`; nothing pushed, no PR, no PR artifact; policy events name both paths; quarantine on `run.failed` |
| `c0/walking-skeleton-ci` | WS-P0-042 | `pnpm probe e2e/walking-skeleton-ci` | e2e test is in CI (`pnpm test`), passes with no network and no keys in under 90 s; `c0/run-fake-e2e` passes the same way; the test asserts PR, bundle, audit chain and cost |
| `scripts/probe-first-real-pr.sh` | WS-P0-043 (human) | `bash scripts/probe-first-real-pr.sh` | real PR at the verified head with the bundle-hash comment; chain verifies; cost under the cap; earlier smoke run under 0.50 USD |
| `scripts/probe-phase0-exit.sh` | WS-P0-044 (human) | `bash scripts/probe-phase0-exit.sh` | demo from a clean clone; C0 review checklist ticked; kill criteria verdict; WS-P0-042, 043, 023 probes pass |
| `c0/orphan-recovery` | none in C0 (WS-P1-001, WS-P1-006) | (KICKOFF Prompt 5) | kill -9 the pipeline mid-run, start fwd: run failed/killed, lease released, vendor group gone, row ready, no double start or fail across a second restart; credential not in the vendor argv |

## Surfaces used (from the code)

| Surface | Used by |
|---|---|
| `fw --help --json` -> `{ commands: [{ usage, summary }] }`; exit codes 0, 1, 2, 4 | cli-skeleton |
| `fw ledger` subcommands: `sync`, `list [--lane]`, `show`, `next`, `retest <code>`, `close <code> --merged-sha <sha>` | ledger probes, pipeline probes |
| `fw wo issue <code> [--doer --verifier]`; XL refused with `SIZE_NOT_DISPATCHABLE` | wo-issue, cli-skeleton |
| `fw run start <code> --adapter fake --scenario <s> [--json]`, `fw run show <run>`, `fw run list` | pipeline probes, cost-record |
| `fw audit verify --json` -> `{ ok, count, head }` | audit-chain, run-fake-e2e |
| `fwd --home <h> --port 0` (prints `listening on`), `FW_DEV_NO_AUTH=1`, `GET /v1/spend?group_by=agent`, startup reconciler | cli-skeleton, cost-record, orphan-recovery |
| `@fw/eventlog` `openStore({ path, readonly?, lockPath? })` | schema-core, event-chain, audit-chain |
| `@fw/ledger` `transitionRow`, `runRowProbe(w, code, { repoDir, target, timeoutMs })`, `workOrderHash` | ledger-fsm, probe-exec, run-fake-e2e, wo-issue |
| `@fw/adapters` `createAdapter`, `createClaudeAdapter({ command, commandArgs, exec })`, `REQUIRED_FLAGS`, `FAKE_SCENARIOS`, `ADAPTER_NAMES`; `AdapterRun { events, result, meta, kill, pgid }` | adapter probes |
| `packages/adapters/test/conformance.ts` `conformanceSuite(harness)` and the replay fixtures in `packages/adapters/test/fixtures/claude/` | adapter-contract, claude-conformance |
| `@fw/daemon` `supervise`, `resolveCredential`, `WorktreeManager`, `prepareSandbox`, `spawnInSandbox`, `killProcessGroup`, `sandboxSelfTest`, `LocalBareHost`, `GhHost`, `buildEvidenceBundle`, `prComment` | runtime, security and kernel probes |
| `@fw/policy` `evaluateDiffPolicy({ changes, tier0Paths, allowedFiles })`, `parseNameStatus`, `CORE_TIER0_PATHS` | diff-policy |
| `@fw/contracts` `validate($id, value)`; `packages/contracts/scripts/gen-types.mjs` | contracts, evidence-builder |
| Row id in the database: `lr_` + the code without hyphens (`FW-C-005` -> `lr_FWC005`) | ledger and pipeline probes, probe-first-real-pr.sh |

Where the code chose differently from the draft and logged the choice in
`docs/decisions/C0-owner-questions.md`, the probes follow the code: run branches `fw/<row>/<run>`
(item 8), run home `$FW_HOME/runs/<run>/home` (9), one worktree per row (13), title-tag scenario
selection (15), `fw ledger retest` instead of `fw ledger ready` (21), the fake writes
`fw-fake/<run>.md` (34), `fw ledger close` needs `--merged-sha` (34), the worktree is kept after a
failed run (34), the evidence builder lives in the daemon (34), the diff is bound by `intent_payload`
(29), the contracts stay at the repo root (1, 4), diff-policy failures use `no_artifact` (30), a
failed run returns the row to ready. Where an item only records that a requirement is not met yet
(items 12, 19, 20, 22, 27), the probe stays strict and the line is listed under "Real gaps".

## Conflicts found between the design docs

1. **ledger-row.json cannot validate a row definition file.** Sync maps the file to the contract
   before validating (decision 24). A `ledger-row-definition.json` schema would remove the mapping.
2. **Backlog key in `ledger_rows`.** Resolved in code: the id is `lr_` + the code without hyphens.
3. **Redact or reject secrets.** The code redacts and records `_redacted` (decision 7).
4. **Tamper event.** FW-C-005 wants a tamper event on sync; no tamper event type exists, but
   `audit.finding_raised` (check `probe_tamper`) is used for a tampered probe run. See "Real gaps".
5. **Adapter interface.** The code: `start` -> `AdapterRun { events, result, meta, kill, pgid }`,
   `fingerprint`, `preflight`, `capabilities` as a property. WS-P0-026's `run/resume/abort` are not
   used; resume is `resume_session_id` in the input.
6. **Orphan recovery is C1, not C0** (decision 26). The probe is written and mapped to no C0 row.
7. **c0/diff-policy is run-level in KICKOFF, a pure function in WS-P0-035.** Split into
   `c0/diff-policy` and `c0/diff-policy-run`.
8. **Agent rows whose files_hint is Tier 0** (WS-P0-004, 005, FW-C-002, 003, 005, WS-P0-023, 025,
   035, 038). An agent PR for any of these fails `check-tier0`. Decide per row: `pair`, or narrow
   Tier 0.
9. **verifying -> done guard text** says it is for a non-merge artifact, but C0's human-merge path
   closes a merged row from verifying.
10. **Probe file convention.** Backlog meta says `probes/<path>.probe.ts`; the runner runs `.mjs`,
    `.sh`, `.py`, `.test.ts`. WS-P0-006 files_hint is `probes/runner.ts`; the runner is
    `scripts/probe.mjs`.
11. **WS-P0-044 review path.** files_hint `docs/phase-reviews/0.md`, core_adaptation
    `docs/milestone-reviews/C0.md`; the script uses the latter.
12. **artifact-required wording.** WS-P0-039 says the row is left in `verifying`; the code fails the
    run and returns the row to `ready`. The probe accepts any status short of verifying, merging,
    watching or done, because the line's intent is "never advance". Owner: confirm.
13. **WS-P0-038 "literal diff in the bundle".** The bundle schema has no diff field (decision 29), so
    the probe accepts the rendered diff file bound by hash. Owner: confirm or change the schema.
14. **FW-C-002 "typecheck fails on drift".** The code checks drift with `gen-types --check` in
    `pnpm test` (CI), not in `tsc`. The probe accepts that.

## Status after reconciliation

Run on 2026-11-09 on the worktree branch (Node 22.23.4, no gitleaks installed, gh not
authenticated, no network for vendors). 22 of 34 C0 probes pass (orphan-recovery counted as passing; it is flaky).

| Probe | Row | Result | Reason |
|---|---|---|---|
| `c0/skeleton` | FW-C-001 | PASS | |
| `c0/workspace-layout` | FW-C-001 | FAIL | `exactOptionalPropertyTypes` is false in tsconfig.json |
| `c0/bootstrap` | WS-P0-002 | PASS | |
| `c0/ci-skeleton` | WS-P0-004 | PASS | CI-runtime line printed SKIPPED (needs `FW_CI_REPO` and gh) |
| `c0/secret-scan` | WS-P0-005 | FAIL | MISSING `.gitleaks.toml` (Owner file) |
| `c0/probe-runner` | WS-P0-006 | FAIL | `scripts/probe.mjs` has no default time limit |
| `c0/contracts` | FW-C-002 | PASS | |
| `c0/schema-core` | FW-C-003 | PASS | |
| `c0/event-chain` | FW-C-004 | PASS | |
| `c0/ledger-sync` | FW-C-005 | FAIL | sync refuses the changed probe but records no tamper event |
| `c0/cli-skeleton` | FW-C-006 | PASS | |
| `c0/ledger-fsm` | WS-P0-016 | PASS | |
| `c0/probe-exec` | WS-P0-019 | FAIL | a probe file differing from `probes/MANIFEST.sha256` runs (exit 0) |
| `c0/premise-retest` | WS-P0-020 | PASS | |
| `c0/ledger-commands` | WS-P0-021 | PASS | |
| `c0/audit-chain` | WS-P0-023 | PASS | |
| `c0/cost-record` | WS-P0-025 | FAIL | `fw spend --by agent` exits 2 (no such command); the API rollup passes |
| `c0/adapter-contract-types` | WS-P0-026 | FAIL | `createAdapter('noop')`: unknown adapter |
| `c0/fake-adapter` | FW-C-007 | PASS | |
| `c0/adapter-contract` | WS-P0-027 | PASS | |
| `c0/supervisor-caps` | WS-P0-028 | PASS | |
| `c0/credential-handle` | WS-P0-029 | PASS | |
| `c0/claude-conformance` | WS-P0-030 | PASS | |
| `c0/worktree-manager` | WS-P0-032 | PASS | |
| `c0/sandbox-selftest` | FW-C-008 | FAIL | env and self-test pass; `fw doctor` and `fw gc` exit 2 (no such commands) |
| `c0/diff-policy` | WS-P0-035 | FAIL | clean and forbidden-path pass; the five content rules are not implemented; no rules file |
| `c0/git-edge` | WS-P0-036 | PASS | |
| `c0/evidence-builder` | WS-P0-038 | PASS | |
| `c0/artifact-required` | WS-P0-039 | PASS | |
| `c0/wo-issue` | WS-P0-040 | PASS | |
| `c0/run-fake-e2e` | WS-P0-041 | PASS | |
| `c0/diff-policy-run` | WS-P0-041 | PASS | |
| `c0/walking-skeleton-ci` | WS-P0-042 | FAIL | e2e passes offline in about 18 s, but asserts no cost rollup |
| `c0/orphan-recovery` | (C1) | PASS, flaky | failed 3 of about 35 runs, all under load: the reconciler left the vendor group alive (see "Real gaps") |
| `scripts/probe-branch-protection.sh` | WS-P0-003 | FAIL | gh is not authenticated (Owner) |
| `scripts/probe-first-real-pr.sh` | WS-P0-043 | FAIL | needs `FW_REAL_ROW` after a real-vendor run (Owner) |
| `scripts/probe-phase0-exit.sh` | WS-P0-044 | FAIL | `scripts/demo-p0.sh` does not exist (Owner, C0 exit) |

## Real gaps in the code

Each line below is a backlog acceptance line the code does not meet yet. The probe stays strict.

| Row | Acceptance line | What is missing |
|---|---|---|
| FW-C-001 | typecheck with exactOptionalPropertyTypes on | `tsconfig.json`: set `exactOptionalPropertyTypes: true` and fix the resulting type errors (decision 27) |
| WS-P0-006 | probe runs are time-limited by default (60 s) | `scripts/probe.mjs` (Tier 0): spawn with a default 60 s limit (overridable), kill the process group, exit nonzero with a message naming the timeout |
| FW-C-005 | changed probe refused "with a tamper event" | `packages/ledger` sync: on a probe-hash mismatch, append `audit.finding_raised` (check `probe_tamper`, row named) in its own transaction, then refuse; ledger_rows stays untouched (decision 19) |
| WS-P0-019 | a modified probe file is refused with `tamper_detected` | the probe executor (`runRowProbe` / `checkedProbe` in `packages/ledger`) does not read `probes/MANIFEST.sha256`; it should hash the probe file a command names and refuse on mismatch (decision 20; needs the Owner's manifest) |
| WS-P0-025 | `fw spend --by agent` prints the rollup | `packages/cli`: add `fw spend --by agent` (and by run or row, with `--json`), the same numbers as `GET /v1/spend` |
| WS-P0-026 | a no-op reference adapter compiles against the SDK | `packages/adapters`: add `noop` to `ADAPTER_NAMES` and `createAdapter` (implements the interface, returns a schema-valid result, spawns nothing) |
| FW-C-008 | "fw doctor shows it"; "removable by fw gc" | `packages/cli`: `fw doctor --json` (runs `sandboxSelfTest` and prints each control's level) and `fw gc --json` (calls `removeRunDir` for finished runs, never touches branches) |
| WS-P0-035 | six violation types named; rules are data in a Tier 0 file | `packages/policy`: content rules `deleted_test`, `skipped_test`, `config_relaxation`, `size_over_cap`, `new_dependency` (the engine needs the diff text or per-file contents, not only name-status), read from `policy/rules/diff-policy.json` (decision 12; the file is the Owner's) |
| WS-P0-042 | asserts ... cost rollup | `e2e/walking-skeleton.test.ts`: assert the run's spend (for example `spend_entries` sum equals `fw run show` cost) |
| (C1) orphan recovery | vendor process group gone after restart | `packages/daemon/src/reconciler.ts` `killOrphanGroup` verifies ownership only through `/proc/<pgid>/cwd` of the group leader. In the failing runs `groups_killed` was empty while a member of the group with its cwd in the run worktree was alive, which fits a leader that had already exited (readlink fails, outcome `unverified`). Fix: verify by any live member of the group (scan `/proc/*/stat` for the pgrp) before killing |

Small code issue seen while reconciling (not fixed, outside probes/): `packages/eventlog/src/lock.ts`
`isAlive` uses `process.kill(pid, 0)`, which reports a zombie as alive. Where PID 1 does not reap
(this container), a killed `fwd` child left as a zombie keeps `fwd.lock` "held" and the next `fwd`
refuses to start. Reading `/proc/<pid>/stat` state `Z` as dead (as `sandbox.ts` already does) fixes it.

## Requires the Owner

| Item | Row | Why only the Owner |
|---|---|---|
| `.gitleaks.toml`, `.husky/pre-commit`, gitleaks installed, the CI secret-scan job | WS-P0-005 | Tier 0 files and tooling |
| `policy/rules/diff-policy.json` (six rule ids and their parameters) | WS-P0-035 | Tier 0 policy data |
| `probes/MANIFEST.sha256` over the committed probe pack | WS-P0-019 | Tier 0; created when the Owner commits the probes |
| Commit this probe pack (it is Tier 0), after review | all | AGENTS.md rules 2 and 3 |
| `exactOptionalPropertyTypes` decision (turn on now, or amend FW-C-001) | FW-C-001 | acceptance change |
| `scripts/probe.mjs` default timeout (the runner is Tier 0) | WS-P0-006 | Tier 0 script |
| Branch protection on main, code-owner review, agent identity without admin; `gh auth login`; `FW_AGENT_TOKEN` | WS-P0-003 | GitHub settings |
| First real-vendor run and PR (`FW_REAL_ROW`, `FW_GH_REPO`, a real API key under a 0.50 USD smoke cap) | WS-P0-043 | human row, real spend |
| `scripts/demo-p0.sh`, `docs/milestone-reviews/C0.md` with ticked checklist and kill-criteria verdict | WS-P0-044 | human row |
| Decisions on the Conflicts above, especially 12, 13 and 14, and items 19, 20, 22, 27, 29 of `docs/decisions/C0-owner-questions.md` | several | acceptance interpretation |
