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
