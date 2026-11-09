# C0: decisions and questions for the Owner

Things the build hit where the handoff docs disagree with each other or leave a choice open. Each has the default the code uses today. Tier 0 items need your edit, not an agent's.

## Layout and Tier 0

1. **Where the Tier 0 contracts live.** START-HERE step 2 copies `schema.core.sql`, `contracts-core/` and `tests/` to the repo root; PACKAGE-LAYOUT and AGENTS.md expect `packages/contracts/{sql,json-schema}`. Default: repo root (the handoff's own tests run unchanged). The repo-root paths are added to the Tier 0 lists.
2. **Four different Tier 0 lists** (AGENTS.md, CODEOWNERS, `core-policy.yaml tier0.paths`, diff policy). Default: one list in code (`CORE_TIER0_PATHS` plus `AGENTS.md`/`CLAUDE.md` in the daemon); `core-policy.yaml` still differs (has `**/CODEOWNERS`, `chain.*`; lacks `contracts-core/`, `schema.core.sql`, `tests/`, `ledger/backlog/`). Yours to reconcile.
3. **`packages/eventlog/src/chain.ts` is Tier 0** but the chain code lives in `envelope.ts` and `store.ts`. Either rename to `chain.ts` or point the Tier 0 entry at the real files.
4. **No `SCHEMA-SNAPSHOT.sha256` check in CI yet** (FW-C-002 acceptance line 3), because the schemas are not copied into `packages/contracts/json-schema/`.

## Event log

5. **Null optional fields in the hash.** The example envelope hash only reproduces when null optional fields are left out; the Python helper in `tests/schema_core_test.py` hashes them as `null`. Default: omit (matches the JSON Schema and the example).
6. **Trigger misses a bare PKCS#8 header.** `*BEGIN * PRIVATE KEY*` does not match `-----BEGIN PRIVATE KEY-----`. Redaction in code catches it; tightening the trigger is a schema change.
7. **How a redaction is recorded.** Default: the JSON paths go in the payload under `_redacted`.

## Runtime

8. **Branch name.** CORE-SPEC says `row/<ID>`; runs use `fw/<row>/<run_id>` so retries never collide.
9. **Sandbox home.** Spec says `$FW_HOME/sandbox/<run>/home/`; code uses `$FW_HOME/runs/<run_id>/`. Easy to change.
10. **Egress proxy.** No variable names the proxy URL; code uses `FW_EGRESS_PROXY`. `NO_PROXY` is loopback only (the spec's "NO_PROXY from FW_EGRESS_ALLOW" would send allowlisted hosts around the proxy).
11. **Sandbox is honest about being weak.** On Linux as one user: env scrub, home isolation, write confinement and process-group kill are `best_effort`; egress is `absent` without a proxy. Nothing is `enforced` until the container flag (FW-C-015, C1).
12. **Diff policy rules as data** (`policy/rules/diff-policy.json`) is Tier 0, so only the path rules (Tier 0, allowed files) are in code. Deleted tests, config relaxation, size cap and new dependency rules are still to do.
13. **One active worktree per row**, not per work order.

## Adapters

14. **Estimated cost has no home.** `run-result.cost` allows no extra fields and `spend_entries` has no `estimated` column. Default: the flag lives in the adapter's run metadata only.
15. **Fake scenario selection.** `vendor-adapter-input` allows no extra fields, so the fake reads a `[fake:<name>]` tag in the work order title (as FW-C-007 says).
16. **Claude CLI 2.1.319 has no `--max-turns`.** The adapter enforces the turn cap itself. Required flags checked at preflight: `--print`, `--output-format stream-json`, `--verbose`, `--bare`, `--session-id`, `--permission-mode acceptEdits`, `--max-budget-usd`, `--json-schema`. Only `ANTHROPIC_API_KEY` is accepted (subscription tokens are refused, per the API-key-lane rule).
17. **Refused runs.** The run-result schema has no refused status; a refused run returns `exit_code: -1`.

## Ledger

18. **Probe result in the evidence bundle.** `evidence-bundle.json` forbids extra fields, so the probe output is bound by hash through `automated_evidence` / `intent_payload` and the API derives a flat `view`. If you want the probe result inline in `body`, that is a schema change, and it should happen before real closes (bundles are immutable).
19. **Tamper on sync.** A changed probe in a row file makes `fw ledger sync` refuse (exit 1) and write no row. No tamper event type exists in the schema, so before refusing, sync records the attempt as `audit.finding_raised` with check `probe_tamper`, the same payload a tampered probe run raises: the row (`ledger_row_id`, `code`, `evidence_refs`), `stored_hash` and `computed_hash` (the row file's probe hash). The finding is appended in its own transaction, apart from the row writes, so it persists while `ledger_rows` and every other table stay unchanged; each refused attempt records its own finding. Running a probe whose stored hash no longer matches raises the same finding.
20. **`probes/MANIFEST.sha256`** (WS-P0-019) does not exist yet; you create it when you commit the probe pack. Until then the tamper check covers only the stored probe hash.
21. **`fw ledger retest <code>`** was added: without it nothing moves a row from open to ready.
22. **Exit code 3 for policy refusal** (FW-C-006) is not used yet; refusals exit 1, a held writer lock exits 4.
23. **Row owners.** `agent` rows are owned by the chief-of-staff agent; `pair` and `human` rows by you (`own_local`).
24. **The ledger-row contract cannot validate a row definition file** (it requires `status` and an `lr_` id). Sync maps the file to the contract before validating.

## Probes (Tier 0, yours)

25. The C0 probe pack in `probes/c0/` was drafted before the code and assumes some names the code does not use (for example `createWorktreeManager` vs the `WorktreeManager` class). It will be reconciled to the real interfaces once `fw run start` lands, still as a draft for your line-by-line review. You commit the final version.
26. `c0/orphan-recovery` belongs to WS-P1-001 (C1), not C0. KICKOFF's single `c0/diff-policy` probe is split into a pure-function probe and a run-level one.
27. FW-C-001's own probe wants `exactOptionalPropertyTypes: true` in tsconfig; it is off today.

## Run pipeline (`fw run start`)

28. **Sandbox and adapter info in the evidence bundle.** `provenance` allows only `untrusted_inputs` and `rule_of_two`, and the bundle allows no extra top-level fields. Default: two `automated_evidence` entries of kind `other` named `sandbox self-test` and `adapter fingerprint`, with a `key=value` summary; the cost record is a `cost_estimate` entry. The API's `view` parses them back. Proposed contract change: `provenance.sandbox {level, controls}` and `provenance.adapter {name, vendor, version, help_sha256}`.
29. **No field for the diff itself.** Default: `intent_payload {rendered_ref: runs/<run>/diff.patch (relative to FW_HOME), payload_hash: sha256 of the bytes, format: diff}`; changed files are `blast_radius.affected`. The API and the decision card used `body.diff.{path,hash,files}`, which a contract-valid bundle cannot carry; both now fall back to the contract fields. Proposed: drop `body.diff` from LOCAL-API-V1 or add `diff {ref, hash, files[]}` to the bundle schema.
30. **A diff-policy violation has no failure class.** Default: `no_artifact` (as the artifact guard already does), with `policy.diff_policy_failed` (and `policy.tamper_tripwire_fired` for Tier 0) carrying the detail. A red evidence bundle and a pushed head that does not match the verified head use `claim_mismatch`. Proposed: add `policy` to `runs.failure_class`.
31. **One writer lock (fixed).** `fwd` and the in-process CLI client both lock `$FW_HOME/fwd.lock`, so `fw run start` refuses (exit 4) while `fwd` is running instead of both writing. In C1 the CLI talks to fwd over HTTP for writes.
32. **Cost record.** Spend is written per model turn as it streams (so the spend hard-stop trigger can fire mid-run), then one `<run>:final` entry for whatever the vendor's final total adds beyond the steps. When the vendor reports no cost the run shows `unknown`, never zero. `spend_entries` still has no `estimated` column (item 14).
33. **Credential handles.** Handles are fixed per adapter in `@fw/adapters` (`crd_fake0001` optional, the real vendor's handle required) because the work order has no field naming them. Keychain service `flowweb`, account = handle. An optional handle whose file exists but is insecure fails the run rather than being skipped. Proposed: `work-order.credentials[] {handle, env, required}`.
34. **Probe drafts disagree with the pipeline spec** (`probes/c0/*.mjs` are Tier 0, so not changed). They expect: `fw ledger ready` and `fw ledger probe` commands, `fw ledger close` without `--merged-sha`, a remote branch named `row/<ID>` (item 8), the fake vendor writing a `files_hint` path such as `src/feature.txt` (it writes `fw-fake/<run>.md`), no worktree left after a failed run (the pipeline keeps it for inspection, as asked), and `buildEvidenceBundle` in `packages/policy` (it is in the daemon; policy is Tier 0). Aligned where cheap: `resolveCredential(handle, {home})` and `supervise(adapter, input, {onEvent})` are exported from `@fw/daemon`, `fw run show` prints the bundle hash, the fake handle is `crd_fake0001`. Which side should move?
35. **Default adapter** is `$FW_VENDOR`, else the adapters package default (the real vendor). The e2e test always passes `--adapter fake`.
36. **Row files must be in the project repo** (`<repo>/ledger/rows/<code>.json`) for `fw run start`: the work-order compiler reads `files_hint` and `acceptance` from there. A row synced from elsewhere gets the restrictive default `docs/notes/<code>/**` and a change outside it is a policy violation.
