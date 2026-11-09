# @fw/daemon (`fwd`)

The FlowWeb Core daemon: one Node 22 process that is the only writer of the database and serves
the loopback HTTP API in [`docs/api/LOCAL-API-V1.md`](../../docs/api/LOCAL-API-V1.md). This
package also holds the run-time modules (worktrees, sandbox, git edge, quarantine, artifact guard);
see `src/index.ts`.

## Run it

```sh
pnpm fwd                         # FW_HOME=~/.flowweb, port 7317
pnpm fwd --home /tmp/fw --port 0 # a throwaway home and a free port
pnpm fwd --pair                  # print a fresh one-time pairing code for a new browser
```

On start `fwd`:

1. Creates `$FW_HOME` and `db/`, `worktrees/`, `runs/`, `pairing/` (mode 0700).
2. Opens `$FW_HOME/db/fw.sqlite` as the single writer, locked by `$FW_HOME/fwd.lock`. A second
   `fwd` on the same home prints `another fwd is already running for FW_HOME=...` and exits 1.
   The lock of a process that died (kill -9) is stale and is taken over.
3. Appends `system.started`.
4. Runs the reconciler: every run left in `starting`, `running` or `validating` is an orphan of a
   crash and becomes `failed` with `failure_class = 'killed'` (`run.failed`); its lease is
   released (`lease.released`); active leases past `expires_at` become `expired`
   (`lease.expired`); then `reconciler.completed`. Paused runs are left alone. Orphans are never
   retried. An orphan's vendor process group (`vendor_pgid` on its `run.started`) is killed when
   it is still alive and, on Linux, its leader's cwd is inside the run's workspace (a reused id is
   never signalled); the outcome is on `run.failed` as `vendor_group`. The work order goes back to
   `issued` and the row to `ready` (or `blocked` if the premise no longer holds), unless another
   run of the same work order is still live.
5. Verifies the hash chain (`verifyChain`) and caches the result for `/v1/status`; it re-verifies
   every 5 minutes. A failure appends `audit.chain_verification_failed`.
6. Writes `$FW_HOME/pairing/cli.token` (0600) if missing, and on a first start (no paired browser
   yet) prints a pairing code, kept in `$FW_HOME/pairing/code` (0600) until used.
7. Listens on `127.0.0.1` only and prints `listening on http://127.0.0.1:<port>/v1`.

SIGINT or SIGTERM appends `system.stopped` (`clean: true`), ends open event streams, closes the
store and exits 0.

## Flags and environment

| Name                     | Meaning                                                                      |
| ------------------------ | ---------------------------------------------------------------------------- |
| `--home DIR` / `FW_HOME` | Home directory. Default `~/.flowweb`.                                        |
| `--port N` / `FW_PORT`   | Loopback port. Default 7317. `0` picks a free port.                          |
| `--host`                 | Fixed to `127.0.0.1`; any other value is refused.                            |
| `--pair`                 | Print a fresh pairing code (the old one stops working).                      |
| `FW_DEV_NO_AUTH=1`       | Skip pairing, cookies and tokens. Development only. The Host guard stays on. |

## Auth

- Browser: `POST /v1/pair {"code": "XXXX-XXXX"}` (`content-type: application/json`) sets
  `fw_session` as an HttpOnly, SameSite=Strict cookie. The code works once; ten wrong codes
  discard it (run `fwd --pair` for a new one). Only sha256 hashes of session tokens are stored,
  in `$FW_HOME/pairing/sessions.json`.
- CLI: `Authorization: Bearer $(cat $FW_HOME/pairing/cli.token)`.
- Every request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` gets 403 (DNS
  rebinding guard). Every write with a foreign `Origin`, or `Sec-Fetch-Site` other than
  `same-origin`/`none`, gets 403. A dev server on another port must proxy with the Host rewritten.
- No CORS headers are sent.

```sh
TOKEN=$(cat ~/.flowweb/pairing/cli.token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7317/v1/status
curl -s -H "Authorization: Bearer $TOKEN" 'http://127.0.0.1:7317/v1/ledger/rows?milestone=C0&status=open'
curl -sN -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7317/v1/events/stream
```

## Routes

All GETs return `{ data, as_of, head_seq, next_cursor }`; errors are
`{ error: { code, message, details } }`. Lists take `?limit=` (default 50, capped at 200) and an
opaque `?cursor=`. Column names are unchanged and JSON columns are parsed.

| Route                                                       | C0  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/pair`                                             | yes | The only C0 write.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET /v1/session`                                           | yes | `{paired_at, device_label}` of the calling session (`device_label: "cli"` for the token).                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /v1/status`                                            | yes | Kill switch from `settings`; chain from the cached `verifyChain`; spend today (UTC) from `spend_entries`; `daily_cap_usd` from the fleet `day` budget (null if none); breaker from `breaker.tripped`/`breaker.reset` events; `paused_by_budget` when any non-run budget is exhausted; `sandbox_level` from the latest `run.started` that recorded one (else null); `open_cards`; `running_runs` (status `running`). Kill details (`engaged_at`, `reason`, `runs_to_halt`, `runs_halted`, `keys_revoked`) come from the setting or the engage event, else null. |
| `GET /v1/status-reports?kind=&limit=`                       | yes | Newest first, `body` parsed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /v1/policy`                                            | yes | `$FW_HOME/policy/core-policy.yaml`, else `$FW_HOME/config/core-policy.yaml`, else the repo's `contracts-core/core-policy.yaml`. `commit` is the repo's `git rev-parse HEAD` for the repo file, null for an override.                                                                                                                                                                                                                                                                                                                                           |
| `GET /v1/projects`, `/v1/projects/{id}`                     | yes |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /v1/ledger/rows?project_id=&status=&milestone=&q=`     | yes | `milestone` matches `wave`; `q` matches title, lane, or the id (hyphens ignored, so `q=FW-C-019` works). Adds `code`.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /v1/ledger/rows/{id}`                                  | yes | `{id}` is the `lr_` id or the code. Adds `evidence[]` (the row's bundle, and bundles whose subject is the row, its work orders or its runs) and `runs[]` (summary).                                                                                                                                                                                                                                                                                                                                                                                            |
| `GET /v1/runs?status=&row_id=&project_id=`, `/v1/runs/{id}` | yes | Adds `row_code`, `last_heartbeat_at` (lease `heartbeat_at`), `sandbox_level`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /v1/runs/{id}/steps`                                   | yes | `seq` order.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /v1/evidence-bundles/{id}`                             | yes | `body` parsed, also offered as `bundle`; `view` derives probe, diff (hash, ref, files), checks, policy rules, sandbox, adapter and cost from the bundle (`src/api/evidence-view.ts`), null where a bundle has no such entry.                                                                                                                                                                                                                                                                                                                                   |
| `GET /v1/evidence-bundles/{id}/diff`                        | yes | `text/x-diff`. Serves `body.diff.path` or `intent_payload.rendered_ref` (inside FW_HOME), or `runs/<run>/diff.patch` for a run bundle, only when its sha256 equals `body.diff.hash` or `intent_payload.payload_hash` (500 if the bytes differ, 404 if nothing is stored).                                                                                                                                                                                                                                                                                      |
| `GET /v1/events?after_seq=&type=&run_id=`                   | yes | `type` may end in `*` (`run.*`). `next_cursor` is the last seq.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /v1/events/stream`                                     | yes | SSE: `id: <seq>`, `event: fw`, `data: <event row>`. Resumes from `Last-Event-ID` (or `?after_seq=`); otherwise starts at the head. Polls every 250 ms; `: heartbeat` every 15 s.                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /v1/spend?group_by=project\|agent\|vendor&from=&to=`   | yes | Default `project`. Rows: the group column, `usd`, token sums, `entries`, `first_ts`, `last_ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /v1/budgets`                                           | yes | Adds `spent_usd` from `budget_usage`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /v1/decision-cards?status=`                            | yes | Urgency, then deadline. Adds `row_code` from `body.source.ledger_row_id`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /v1/decision-cards/{id}`                               | yes | Adds `approval`, `pr` (from the source run's `pull_request` artifact), `files` (from the bundle's `diff.files`, else `blast_radius.affected`, else null); `merge_slot` and `policy` are null until C1.                                                                                                                                                                                                                                                                                                                                                         |
| `GET /v1/approvals/{id}`                                    | yes | `request`, `response` parsed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `POST /v1/approvals/{id}/respond`                           | 501 | FW-C-010 (C1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `POST /v1/decision-cards/{id}/answer`                       | 501 | FW-C-021 (C1/C2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST /v1/decision-cards/{id}/snooze`                       | 501 | FW-C-021 (C2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `POST /v1/kill-switch`, `POST /v1/kill-switch/release`      | 501 | FW-C-012 (C1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `POST /v1/ledger/rows/{id}/accept`                          | 501 | FW-C-027 (C2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `DELETE /v1/session`                                        | 501 | FW-C-019 (C2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

A 501 body is `{ "error": { "code": "not_implemented", "details": { "row": "...", "milestone": "..." } } }`.

## `fw run start` (the C0 run pipeline)

`src/pipeline/run-start.ts`. In C0 the CLI calls it in-process: this package declares
`fw.coreClient` (priority 20, above the ledger's 10) in `package.json`, and `src/local-client.ts`
wraps the ledger client and adds `runStart`, `runList` and `runShow`. The CLI still imports only
`@fw/contracts`.

```sh
fw ledger sync
fw run start FW-T-001 --adapter fake [--scenario forbidden_path] [--host local:/path/origin.git] [--base main] [--max-wall-clock-s 60]
fw run list [--status failed]
fw run show <run_id>
```

| Step                 | What happens                                                                                                                                                                                                                                                                                           | On failure                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| 1. Premise           | An `open` row is re-tested; the probe must fail (else the row is parked). Only `ready`/`claimed` rows run; one live run per row. Kill switch checked.                                                                                                                                                  | refused, no run                           |
| 2. Order, run, lease | Issues a work order unless one is live (an expired one is expired first). Run `queued`, lease on `branch:fw/<row>` with the next fence token, `ready -> claimed`. Admission (`queued -> starting`) is the schema trigger: kill switch, budgets, lease, work order.                                     | `cancelled` (+ `dispatch.refused_budget`) |
| 3. Worktree          | `$FW_HOME/worktrees/<run_id>` on `fw/<row>/<run_id>` from the base commit.                                                                                                                                                                                                                             | `failed`                                  |
| 4. Sandbox           | `prepareSandbox` + self-test; `sandbox_level` and every control on `run.started`. `requiredControls` refuses when a required control is `absent` (none is required in C0).                                                                                                                             | `failed`                                  |
| 5. Credentials       | Handles from `ADAPTER_CREDENTIALS` (`src/creds`): OS keychain if its tool is on PATH, else `$FW_HOME/creds/<handle>` (regular file, this uid, no group/world bits). Values go only into the vendor env; handles (never values) are on `run.started`. Insecure files are a typed `CREDENTIAL_INSECURE`. | `failed` (`adapter`)                      |
| 6. Adapter           | Under `startSupervised` (wall clock, turns, usd from the work order; `--max-wall-clock-s` only tightens). Steps go to `run_steps` and `runs/<run>/steps.jsonl`, spend per step to `spend_entries`; `trg_spend_hard_stop` is the backstop.                                                              | `timed_out`/`timeout`, `killed`/`budget`  |
| 7. Diff policy       | Tier 0 (`TIER0_PATHS` + `AGENTS.md`, `CLAUDE.md`) and `scope.touches`. A violation quarantines the branch to `fw/quarantine/<run_id>` and pushes nothing.                                                                                                                                              | `failed` (`no_artifact`)                  |
| 8. Artifact guard    | Success needs a kernel-verified commit (`run_artifacts`, `verified_by_kernel = 1`); a vendor claim the kernel cannot find is `run.claim_mismatch`.                                                                                                                                                     | `failed` (`no_artifact`/`claim_mismatch`) |
| 9. Evidence          | Row probe and checks run on the branch outside the model; `runs/<run>/diff.patch`; a contract-valid bundle (`src/pipeline/evidence.ts`, `captured_by: kernel`); `evidence.bundle_created`. A red bundle fails the run.                                                                                 | `failed` (`claim_mismatch`)               |
| 10. PR               | Push, open the PR, post the evidence comment, check the remote head; `pull_request` artifact, run `succeeded`, work order `completed`, row `verifying` with its `evidence_bundle_id`, lease released.                                                                                                  | `failed` (`adapter`)                      |

Every failure ends the run in one transaction (status, `run.<status>` event, leases, work order
back to `issued`, row back to `ready` or `blocked`) and keeps the worktree for inspection. On
success the worktree is removed (the branch is on the host). Exit code 0 only when the PR is open
and the row is `verifying`.

## Tests

`e2e/walking-skeleton.test.ts` (repo root) runs the whole skeleton as separate `fw` processes with
the fake vendor and a local bare git host, plus the failure cases (forbidden path, over budget,
hang, secret leak, insecure credential file, fabricated claim, kill -9 then restart).
`test/evidence.test.ts`, `creds.test.ts` and `supervisor.test.ts` are the unit tests of those rows.

`packages/daemon/test/api.test.ts`, `auth.test.ts` and `process.test.ts` start the daemon on an
ephemeral port against a temp FW_HOME seeded through the Writer. `process.test.ts` runs `fwd` as a
child process for the lock, SIGTERM and kill -9 recovery cases.
