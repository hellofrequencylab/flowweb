# C0 probe pack (Tier 0, DRAFT for Owner review)

Every C0 row of `ledger/backlog/CORE-BACKLOG.json` has a probe here (or, for the three human rows, a
bash script under `scripts/probe-*.sh`). A probe fails today because its target does not exist, and
passes when the row's work is done. Probes are Tier 0: agents never edit them (AGENTS.md rules 2
and 3; CI job `probe-immutability`).

Run one: `pnpm probe c0/<name>` (the runner sets `FW_REPO_ROOT`). Every backlog `verify_probe`
command for a C0 row resolves: `probes/<lane>/<name>.mjs` is a thin wrapper that runs the C0 probe(s)
proving that row.

## Conventions

- Behaviour is tested only through public surfaces: the `fw` CLI (`tsx packages/cli/src/bin.ts`),
  the Store port (`openStore` from `packages/eventlog/src/index.ts`), `createAdapter` (and a few
  other named exports) from a package index, and the database at `$FW_HOME/db/fw.sqlite`, read with
  `node:sqlite` read-only. A probe writes to the database directly only to play the attacker
  (tamper tests) or to load a test fixture (`fixtures/cost-fixture.sql`).
- Each probe uses a fresh temporary `FW_HOME` and, where a repository is needed, a scratch git repo
  with a local bare remote (`_lib.mjs` `fixtureProject` / `projectFromFiles`). Fixture rows use ids
  `FW-C-9nn` and carry their fake-vendor scenario as a `[fake:<name>]` tag in the title.
- The first output line of a failing probe says `MISSING <probe>: ...` (the surface does not exist
  yet) or `FAIL <probe>: ...` (it exists and misbehaves). In `.test.ts` probes the same text follows
  `MISSING:` / `FAIL:` in vitest's error line.
- `_lib.mjs` holds shared helpers and is not a probe. `fixtures/` holds fixture probes and data used
  by the probes; they are not row probes.
- No secret-shaped literal is stored in this directory: fake secrets are assembled at runtime
  (`fakeSecret()`).

## Probe to row map

| Probe | Row | Backlog `verify_probe` | Acceptance lines it proves |
|---|---|---|---|
| `c0/skeleton` | FW-C-001 | (KICKOFF Prompt 1) | eight `@fw` packages exist and resolve; boundary lint clean; cli -> eventlog import fails the lint |
| `c0/workspace-layout` | FW-C-001 | `pnpm probe devex/workspace-layout` | frozen lockfile satisfies package.json; typecheck passes with strict, noUncheckedIndexedAccess and exactOptionalPropertyTypes on; `@fw/ledger` -> `@fw/adapters` fails the boundary lint; re-runs `c0/skeleton` |
| `c0/bootstrap` | WS-P0-002 | `node scripts/check-bootstrap.mjs` | CLAUDE.md imports AGENTS.md; CODEOWNERS covers every Tier 0 path of AGENTS.md; PR template has ledger-row, probe-output, tier-touched fields (plus: AGENTS.md list equals check-tier0's list, no `@OWNER`) |
| `scripts/probe-branch-protection.sh` | WS-P0-003 (human) | `bash scripts/probe-branch-protection.sh` | direct push to main rejected (protection, PRs required, no force push, admins included); Tier 0 PR needs code-owner approval (code-owner review, stale dismissal, CODEOWNERS valid on GitHub); agent token has no admin, maintain or bypass |
| `c0/ci-skeleton` | WS-P0-004 | `pnpm probe devex/ci-skeleton` | a type error fails CI (checks job runs typecheck; injected error fails tsc); an agent PR editing `probes/` fails CI (probe-immutability job + check-tier0 on a real history); CI under 4 minutes only with `FW_CI_REPO` and gh (else printed as SKIPPED); every action pinned by SHA |
| `c0/secret-scan` | WS-P0-005 | `pnpm probe security/secret-scan-fixture` | a key-shaped string is blocked by the pre-commit hook; CI's secret-scan job runs gitleaks with `.gitleaks.toml`, which flags the string; `.gitleaks.toml` exists and is Tier 0 |
| `c0/probe-runner` | WS-P0-006 | `pnpm probe devex/probe-runner` | a probe whose target is missing exits nonzero; a missing probe file exits 2 with a clear message; default 60 s limit (stopped between 55 and 75 s, says timeout, children gone). Takes about a minute. |
| `c0/contracts` | FW-C-002 | `pnpm probe kernel/contracts-core` | 17 schemas compile, 17 valid examples pass, 4 invalid rejected via `validate($id, value)`; vendored copy identical and snapshot verified; an unrecorded schema edit fails the snapshot; generated types committed |
| `c0/schema-core` | FW-C-003 | `pnpm probe kernel/schema-core` | store applies exactly schema.core.sql and records its sha256; WAL; writer and reader have foreign_keys on; a changed recorded hash is refused on open |
| `c0/event-chain` | FW-C-004 | `pnpm probe kernel/event-writer` | 1,000 events verify (store and independent recompute with the reference formula); a flipped payload byte is reported by seq; delete and update refused; idempotent append; API-key-shaped payload redacted and the redaction recorded; second writer process gets a typed lock error fast, nothing lost or duplicated |
| `c0/ledger-sync` | FW-C-005 | `pnpm probe kernel/ledger-sync` | 67 rows import as open with 67 `ledger.row_created`; second sync idempotent; a changed probe is refused (exit 1, row named), ledger_rows untouched, tamper event recorded; status in a row file is never imported; sync never writes row files |
| `c0/cli-skeleton` | FW-C-006 | `pnpm probe cli/skeleton` | every listed command takes `--json` and prints one JSON document; exit 2 usage, 3 policy refusal, 4 locked writer; help lists only implemented commands; `--home` overrides `FW_HOME` |
| `c0/ledger-fsm` | WS-P0-016 | `pnpm probe kernel/ledger-fsm` | open -> done and open -> merging refused with no change; legal transitions each emit `ledger.row_status_changed`. The done -> regressed line is proven by `c0/run-fake-e2e`. |
| `c0/probe-exec` | WS-P0-019 | `pnpm probe kernel/probe-exec` | a probe over its timeout is killed and recorded as fail; a probe file differing from `probes/MANIFEST.sha256` is refused with `tamper_detected`; `ledger.probe_executed` carries stdout tail, exit code, duration |
| `c0/premise-retest` | WS-P0-020 | `pnpm probe kernel/premise-retest` | a row whose probe already passes cannot become ready and is parked as already satisfied; `ledger.row_premise_retested` records each result; a failing probe makes the row ready |
| `c0/ledger-commands` | WS-P0-021 | `pnpm probe cli/ledger-commands` | `fw ledger next` prints exactly the one ready row whose dependencies are done; `fw ledger close` refuses when the probe fails; list, list --lane, show, next, close all take `--json` |
| `c0/audit-chain` | WS-P0-023 | `pnpm probe security/audit-chain` | a flipped payload byte makes `fw audit verify` fail naming the seq; verify of 100k events under 5 s; `fw audit head` exports the head seq and hash |
| `c0/cost-record` | WS-P0-025 | `pnpm probe kernel/cost-record` | `fw spend --by agent` equals the SQL sum of the fixture's spend; `fw run show` gives a run's rollup; a run with no cost data is "unknown", never 0 |
| `c0/adapter-contract-types` | WS-P0-026 | `pnpm probe adapters/contract-types` | SDK under `packages/adapters/src/sdk/` names no vendor; `noop` and `fake` implement start, kill, fingerprint, capabilities; capabilities declare the three booleans |
| `c0/fake-adapter` | FW-C-007 | `pnpm probe adapters/fake-vendor` | nine scenarios give the expected run-result status; no network, no keys; fabricated claim names a PR that does not exist; secrets never emitted; runaway stopped with no process left; forbidden_path really writes CODEOWNERS and a probes/ file |
| `c0/adapter-contract` | WS-P0-027 | `pnpm probe adapters/conformance-suite` | fake passes all 8 cases; a fake broken for one case fails exactly that case; no network or keys; claude and codex under `FW_LIVE_VENDORS=1` (skipped otherwise) |
| `c0/supervisor-caps` | WS-P0-028 | `pnpm probe runtime/supervisor-caps` | a runaway is killed within 2 s of the wall-clock cap; `cap_breach` names the cap (wall_clock, usd); no orphan processes |
| `c0/credential-handle` | WS-P0-029 | `pnpm probe security/credential-handle` | a handle resolves from the 0600 file stub; a missing secret gives a typed error naming the handle and the fix; a 0644 file is refused. "Absent from args and run files" is proven by `c0/run-fake-e2e`. |
| `c0/claude-conformance` | WS-P0-030 | `pnpm probe adapters/claude-conformance` | preflight fails closed on missing flags and never runs a prompt; fingerprint = version + sha256(help); a non api_key credential is refused; live conformance (with session resume) under `FW_LIVE_VENDORS=1` |
| `c0/worktree-manager` | WS-P0-032 | `pnpm probe runtime/worktree-manager` | second worktree for the same order refused; removal leaves no git metadata; path outside the checkout, under `$FW_HOME/worktrees` |
| `c0/sandbox-selftest` | FW-C-008 | `pnpm probe runtime/sandbox-userdir` | child env holds only allowlisted variables and the HOME override; each control reported enforced, best_effort or absent and shown by `fw doctor`; the reported level matches what was enforced (process group, egress, os user); `fw gc` removes the run directory and leaves the branch |
| `c0/diff-policy` | WS-P0-035 | `pnpm probe policy/diff-policy` | six fixture diffs fail with forbidden_path, deleted_test, skipped_test, config_relaxation, size_over_cap, new_dependency; a clean diff passes; rules are data in `policy/rules/diff-policy.json` (an edited copy changes the verdict) |
| `c0/git-edge` | WS-P0-036 | `pnpm probe adapters/git-edge` | PR against the local bare host returns URL and head SHA; an admin-scoped token is refused; 5xx retried with backoff and logged |
| `c0/evidence-builder` | WS-P0-038 | `pnpm probe kernel/evidence-builder` | literal diff in the bundle; every member changes the hash; same input same hash; schema-valid; PR comment text carries the hash |
| `c0/artifact-required` | WS-P0-039 | `pnpm probe kernel/artifact-required` | a fabricated PR URL never makes the run succeeded or the row advance; no kernel-verified artifact; `run.claim_mismatch` recorded |
| `c0/wo-issue` | WS-P0-040 | `pnpm probe kernel/work-order-compile` | work order validates against work-order.json; no files_hint gives no catch-all scope; deterministic content_hash; touches from files_hint, acceptance from the probe, caps from size; self-verify, unready row and XL (exit 3) refused |
| `c0/run-fake-e2e` | WS-P0-041 | `pnpm probe e2e/walking-skeleton-fake` | fake run ends with a verified PR, evidence bundle and cost record; failure leaves `run.failed` and no worktree; re-run refused. Also: WS-P0-016 (every transition has an event; done -> regressed), WS-P0-021 (close after merge gives done bound to the merged SHA), WS-P0-029 (no credential leak under `FW_HOME` or in the remote), WS-P0-039, WS-P0-023 |
| `c0/diff-policy-run` | WS-P0-041 | `pnpm probe e2e/walking-skeleton-fake` | KICKOFF's c0/diff-policy line: a run touching CODEOWNERS or a probe file fails and the branch is quarantined (not pushed as `row/<ID>`, no PR, quarantine event) |
| `c0/walking-skeleton-ci` | WS-P0-042 | `pnpm probe e2e/walking-skeleton-ci` | `e2e/walking-skeleton.test.ts` passes with no network and no keys in under 90 s and references PR, bundle, chain and cost; `c0/run-fake-e2e` passes under the same conditions |
| `scripts/probe-first-real-pr.sh` | WS-P0-043 (human) | `bash scripts/probe-first-real-pr.sh` | real PR exists at the verified head with the bundle-hash comment; chain verifies; cost under the work-order cap; an earlier real-vendor smoke run under a 0.50 USD cap |
| `scripts/probe-phase0-exit.sh` | WS-P0-044 (human) | `bash scripts/probe-phase0-exit.sh` | demo script exists and runs from a clean clone (`FW_DEMO_RUN=1`); `docs/milestone-reviews/C0.md` checklist fully ticked; kill criteria with a verdict line; WS-P0-042, WS-P0-043 and WS-P0-023 probes pass |
| `c0/orphan-recovery` | none in C0 (WS-P1-001, WS-P1-006) | (KICKOFF Prompt 5) | kill -9 fwd mid-run, restart: run failed or killed, lease released, vendor process gone, no double execution |

## Assumed surfaces (Owner: confirm or change before the rows start)

The design docs name the CLI commands and the Store port; the probes had to pin the rest. Each
assumption is in exactly one place in the probe that uses it.

| Surface | Used by | Source or reason |
|---|---|---|
| `fw --help --json` -> `{ commands: [...] }` | cli-skeleton | FW-C-006 "every command accepts --json" + "help lists no unimplemented command" |
| `fw ledger ready <ID>` (Owner marks ready; runs the premise re-test) | premise-retest, ledger-commands, wo-issue, pipeline probes | CORE-SPEC 5.1 step 2; no command named anywhere |
| `fw ledger probe <ID>` (run the row probe now, record it) | probe-exec, run-fake-e2e (regression) | WS-P0-019, WS-P0-016; no command named |
| `FW_PROBE_TIMEOUT_S` | probe-exec | to test the timeout without a 60 s wait |
| `fw audit head --json` | audit-chain | WS-P0-023 "chain head can be exported" |
| `fw spend --by agent`, `fw run show <run>` | cost-record, run-fake-e2e | named in WS-P0-025 |
| `fw doctor --json`, `fw gc --json` | sandbox-selftest | named in FW-C-008 and WS-P1 rows |
| `fw wo issue <ID> --dry-run --doer --verifier` | wo-issue | KICKOFF Prompt 3 (self-verify), WS-P0-040 (deterministic compile) |
| `FW_VENDOR=fake`, `FW_GIT_HOST=local`, remote = `origin` of the cwd repo | pipeline probes | WS-P0-036 adaptation (local bare-repo host) |
| `validate(schemaId = $id, value)` from `@fw/contracts` | contracts, evidence-builder | KICKOFF Prompt 2 names `validate(schemaId, value)`; the id form is a choice |
| `packages/contracts/src/generated/` | contracts | FW-C-002 "generated types are committed" |
| adapter: `start(input)` async stream ending in `{ type: 'result', result }`, `kill()`, `fingerprint()`, `capabilities()`, `requiredFlags()` (claude), options `{ bin, credential }`, `{ broken }` | adapter probes | KICKOFF Prompt 4 + WS-P0-026 (they disagree; see Conflicts) |
| fake scenarios `success, schema_invalid, nonzero_exit, runaway, cost_overrun, fabricated_claim, injection, secret, forbidden_path`, tag `[fake:<name>]` in the work-order title; success writes `scope.touches[0]`; vendor text events carry `untrusted: true` | fake-adapter and pipeline probes | union of FW-C-007 and KICKOFF |
| `runConformance(adapter)` -> 8 `{ case, ok }` | adapter-contract, claude-conformance | WS-P0-027 |
| `@fw/daemon`: `supervise`, `resolveCredential`, `createWorktreeManager`, `runInSandbox`, `createGitEdge` | supervisor-caps, credential-handle, worktree-manager, sandbox-selftest, git-edge | rows WS-P0-028, 029, 032, FW-C-008, WS-P0-036 (files_hint under packages/daemon) |
| `@fw/ledger`: `transitionRow(writer, rowKey, to, ctx)` | ledger-fsm | WS-P0-016 |
| `@fw/policy`: `evaluateDiffPolicy`, `buildEvidenceBundle`; rule ids in `policy/rules/diff-policy.json` | diff-policy, evidence-builder | WS-P0-035, WS-P0-038 |
| Backlog row key in the database: found via `fw ledger show <ID>`; raw SQL matches `ledger_rows.title LIKE '%<ID>%'` | ledger-sync, pipeline probes, probe-first-real-pr.sh | `ledger_rows` has no column for `FW-C-nnn` (see Conflicts) |

## Conflicts found between the design docs

1. **ledger-row.json cannot validate a row definition file.** It requires `status`, `project_id`,
   `owner`, a full `probe` object and `created_at`, with `id` matching `^lr_...` and
   `additionalProperties: false`. Backlog ids are `FW-C-nnn` / `WS-Pn-nnn` and row files must never
   carry status. `scripts/seed-rows.mjs` therefore checks only the fields the two shapes share
   (title, priority, lane, size) against the schema's own property rules. Needs a decision: a
   `ledger-row-definition.json` schema, or a documented mapping.
2. **No place for the backlog key in `ledger_rows`.** `id` must be `lr_%` and there is no `key`
   column, so `FW-C-005` can live only in the title or `links`. The probes use `fw ledger show <ID>`
   and fall back to the title in raw SQL.
3. **Redact or reject secrets.** FW-C-004: redact before write and record the redaction. KICKOFF
   Prompt 2: rejected by the tripwire. schema.core.sql: the trigger rejects, and comments say the
   daemon redacts first. There is no redaction event type. The probe follows the row.
4. **Tamper event.** FW-C-005 wants a tamper event; KICKOFF wants the database untouched;
   WS-P0-019 names `tamper_detected`; `event_types` has none (closest: `audit.finding_raised`). The
   probes require ledger_rows untouched plus some event mentioning tamper.
5. **Adapter interface.** WS-P0-026: `run(...)`, `resume`, `abort`, `capabilities`. KICKOFF Prompt 4:
   `start` (event stream), `kill`, `fingerprint`. Probes use KICKOFF's plus `capabilities`.
6. **Fake scenarios and selection.** FW-C-007 and KICKOFF each list seven, overlapping in three;
   FW-C-007 selects by a title tag, KICKOFF by a scenario name in the input. Probes use the union
   (nine) and the title tag.
7. **Orphan recovery is C1, not C0.** KICKOFF Prompt 5 makes `c0/orphan-recovery` a C0 acceptance
   probe, but the daemon (WS-P1-001) and reconciler (WS-P1-006) are C1 rows, and WS-P0-041 says C0
   runs in-process. The probe is written, mapped to no C0 row.
8. **c0/diff-policy is run-level in KICKOFF, a pure function in WS-P0-035.** Split into
   `c0/diff-policy` (WS-P0-035) and `c0/diff-policy-run` (WS-P0-041).
9. **KICKOFF Prompt 2 lists "C0 event-log rows (WS-P0-005, WS-P0-006)"**, which are the secret scan
   and the probe runner.
10. **Agent rows whose files_hint is Tier 0.** WS-P0-004 (ci.yml, check-tier0.mjs), WS-P0-005
    (.gitleaks.toml, ci.yml), FW-C-002 (packages/contracts/json-schema/, SCHEMA-SNAPSHOT),
    FW-C-003 (packages/contracts/sql/, tests/schema_core_test.py), FW-C-005 (ledger/rows/),
    WS-P0-023 (packages/eventlog/src/chain.ts), WS-P0-025, WS-P0-035, WS-P0-038 (all of
    `packages/policy/` is Tier 0; WS-P0-035 also writes `policy/rules/`). An agent PR for any of these
    fails `check-tier0`. Decide per row: make it `pair`, or narrow Tier 0 (for example
    `packages/policy/` to the engine only).
11. **FW-C-001 is not met by the bootstrap.** Its acceptance needs `exactOptionalPropertyTypes` on;
    `tsconfig.json` has it off, and the `tsconfig.base.json` named in files_hint does not exist. So
    `devex/workspace-layout` fails today.
12. **Cross-row probe dependencies.** WS-P0-021's "next prints a ready row" needs `fw ledger ready`
    (WS-P0-020), not in its depends_on. WS-P0-016's done -> regressed and WS-P0-029's "never in
    run files" need the pipeline (WS-P0-041); they are proven by `c0/run-fake-e2e`.
13. **verifying -> done guard text.** `legal_transitions` says verifying -> done is for a non-merge
    artifact, but C0's human-merge path closes a merged row from verifying (WS-P0-021 adaptation).
    The trigger does not read the guard text, so it works, but the text contradicts the C0 flow.
14. **Probe file convention.** Backlog meta says `probes/<path>.probe.ts`; the runner runs
    `.mjs`, `.sh`, `.py`, `.test.ts`. WS-P0-006 files_hint is `probes/runner.ts`; the runner is
    `scripts/probe.mjs`.
15. **WS-P0-044 review path.** files_hint `docs/phase-reviews/0.md`, core_adaptation
    `docs/milestone-reviews/C0.md`; the script uses the latter.
16. **`pnpm -r` ran nothing.** AGENTS.md (Commands) and the old CI used `pnpm -r lint/typecheck/test`;
    no package defines those scripts, so `-r` was a no-op. CI now uses the root scripts; the
    AGENTS.md Commands block is unchanged in this draft.
17. **Housekeeping label.** The PR template mentions a `housekeeping` label instead of a row id;
    AGENTS.md rule 5 and this check allow only `bootstrap`.
18. **vitest root config** includes only `packages/*/test`, so `e2e/walking-skeleton.test.ts`
    (WS-P0-042) needs a config change by that row.
19. **ledger/rows/README.md** says `fw ledger sync` runs each new row's probe and refuses one that
    already passes; FW-C-005's acceptance does not ask for that, so no probe checks it.

## Status at draft time

Run on 2026-11-09 at commit time of this draft (Node 22.23.4, no gitleaks installed, gh not authenticated).
Expected: `c0/skeleton` and `c0/bootstrap` pass; `c0/ci-skeleton` passes because this draft does
WS-P0-004's work (its CI-runtime line printed SKIPPED); everything else fails until its row is done.

| Probe | Row | Result | First line of the failure |
|---|---|---|---|
| `c0/skeleton` | FW-C-001 | PASS |  |
| `c0/workspace-layout` | FW-C-001 | FAIL | FAIL c0/workspace-layout: tsconfig compilerOptions.exactOptionalPropertyTypes is false, must be true |
| `c0/bootstrap` | WS-P0-002 | PASS |  |
| `c0/ci-skeleton` | WS-P0-004 | PASS |  |
| `c0/secret-scan` | WS-P0-005 | FAIL | MISSING c0/secret-scan: .gitleaks.toml does not exist (secret-scan allowlist, row WS-P0-005) |
| `c0/probe-runner` | WS-P0-006 | FAIL | FAIL c0/probe-runner: the runner did not stop a never-ending probe within 150 s (no default limit) |
| `c0/contracts` | FW-C-002 | FAIL | MISSING: packages/contracts/src/index.ts does not export validate (row FW-C-002) |
| `c0/schema-core` | FW-C-003 | FAIL | MISSING: packages/eventlog/src/index.ts does not export openStore (row FW-C-003) |
| `c0/event-chain` | FW-C-004 | FAIL | MISSING: packages/eventlog/src/index.ts does not export openStore (row FW-C-004) |
| `c0/ledger-sync` | FW-C-005 | FAIL | MISSING c0/ledger-sync: packages/cli/src/bin.ts does not exist (fw CLI entry point, row FW-C-006) |
| `c0/cli-skeleton` | FW-C-006 | FAIL | MISSING c0/cli-skeleton: packages/cli/src/bin.ts does not exist (fw CLI entry point, row FW-C-006) |
| `c0/ledger-fsm` | WS-P0-016 | FAIL | MISSING: packages/ledger/src/index.ts does not export transitionRow (row WS-P0-016) |
| `c0/probe-exec` | WS-P0-019 | FAIL | MISSING c0/probe-exec: packages/cli/src/bin.ts does not exist (fw CLI entry point, row FW-C-006) |
| `c0/premise-retest` | WS-P0-020 | FAIL | MISSING c0/premise-retest: packages/cli/src/bin.ts does not exist (fw CLI entry point, row FW-C-006) |
| `c0/ledger-commands` | WS-P0-021 | FAIL | MISSING c0/ledger-commands: packages/cli/src/bin.ts does not exist (fw CLI entry point, row FW-C-006) |
| `c0/audit-chain` | WS-P0-023 | FAIL | MISSING: packages/eventlog/src/index.ts does not export openStore (row WS-P0-023) |
| `c0/cost-record` | WS-P0-025 | FAIL | MISSING c0/cost-record: packages/cli/src/bin.ts does not exist (fw CLI entry point, row FW-C-006) |
| `c0/adapter-contract-types` | WS-P0-026 | FAIL | MISSING: packages/adapters/src/sdk/ does not exist (adapter SDK, WS-P0-026) |
| `c0/fake-adapter` | FW-C-007 | FAIL | MISSING: packages/adapters/src/index.ts does not export createAdapter (row FW-C-007) |
| `c0/adapter-contract` | WS-P0-027 | FAIL | MISSING: packages/adapters/src/index.ts does not export runConformance (row WS-P0-027) |
| `c0/supervisor-caps` | WS-P0-028 | FAIL | MISSING: packages/daemon/src/index.ts does not export supervise (row WS-P0-028) |
| `c0/credential-handle` | WS-P0-029 | FAIL | MISSING: packages/daemon/src/index.ts does not export resolveCredential (row WS-P0-029) |
| `c0/claude-conformance` | WS-P0-030 | FAIL | MISSING: packages/adapters/src/index.ts does not export createAdapter (row WS-P0-030) |
| `c0/worktree-manager` | WS-P0-032 | FAIL | MISSING: packages/daemon/src/index.ts does not export createWorktreeManager (row WS-P0-032) |
| `c0/sandbox-selftest` | FW-C-008 | FAIL | MISSING: packages/daemon/src/index.ts does not export runInSandbox (row FW-C-008) |
| `c0/diff-policy` | WS-P0-035 | FAIL | MISSING: policy/rules/diff-policy.json does not exist (Tier 0 rules data, WS-P0-035) |
| `c0/git-edge` | WS-P0-036 | FAIL | MISSING: packages/daemon/src/index.ts does not export createGitEdge (row WS-P0-036) |
| `c0/evidence-builder` | WS-P0-038 | FAIL | MISSING: packages/policy/src/index.ts does not export buildEvidenceBundle (row WS-P0-038) |
| `c0/artifact-required` | WS-P0-039 | FAIL | MISSING c0/artifact-required: packages/cli/src/bin.ts does not exist (fw CLI entry point, row FW-C-006) |
| `c0/wo-issue` | WS-P0-040 | FAIL | MISSING c0/wo-issue: packages/cli/src/bin.ts does not exist (fw CLI entry point, row FW-C-006) |
| `c0/run-fake-e2e` | WS-P0-041 | FAIL | MISSING c0/run-fake-e2e: packages/cli/src/bin.ts does not exist (fw CLI entry point, row FW-C-006) |
| `c0/diff-policy-run` | WS-P0-041 | FAIL | MISSING c0/diff-policy-run: packages/cli/src/bin.ts does not exist (fw CLI entry point, row FW-C-006) |
| `c0/walking-skeleton-ci` | WS-P0-042 | FAIL | MISSING c0/walking-skeleton-ci: e2e/walking-skeleton.test.ts does not exist (row WS-P0-042) |
| `c0/orphan-recovery` | (C1: WS-P1-001/006) | FAIL | MISSING c0/orphan-recovery: packages/daemon/src/bin.ts does not exist (daemon fwd, WS-P1-001) |
| `scripts/probe-branch-protection.sh` | WS-P0-003 | FAIL | FAIL probe-branch-protection: gh is not authenticated (gh auth login) |
| `scripts/probe-first-real-pr.sh` | WS-P0-043 | FAIL | FAIL probe-first-real-pr: set FW_REAL_ROW to the row id that was run |
| `scripts/probe-phase0-exit.sh` | WS-P0-044 | FAIL | FAIL probe-phase0-exit: scripts/demo-p0.sh does not exist |
