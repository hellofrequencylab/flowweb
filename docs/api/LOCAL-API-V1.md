# fwd local API v1 (the contract @fw/web codes against)

Status: draft for C0/C2. Owner: the Core thread. The web UI codes against this file; the daemon implements it.
Subset of the full plan's `app-plan/03-contracts/API.md` section 5, same paths and names.

## Transport

- Base URL: `http://127.0.0.1:${FW_PORT:-7317}/v1`. Loopback only.
- Auth: first `fwd` start prints a pairing code. `POST /v1/pair {code}` sets an HttpOnly session cookie `fw_session`. Every other route needs it (the CLI uses a token file at `$FW_HOME/pairing/cli.token` sent as `Authorization: Bearer`). Until pairing ships (FW-C-019), dev mode `FW_DEV_NO_AUTH=1` skips it.
- JSON only. Field names are the SQLite column names from `schema.core.sql` (snake_case), unchanged. JSON columns are returned parsed.
- Derived read-only fields (not columns): ledger rows carry `code` (human row code, e.g. `FW-C-019`; the id is the code without hyphens, `lr_FWC019`, because ids must match `^lr_[0-9A-Za-z]{4,40}$`); runs and cards that reference a row carry `row_code`; runs carry `last_heartbeat_at` from their lease (`leases.heartbeat_at`). The UI shows a run as Running only when that is under 120 s old.

## Envelope (honest UI)

Every GET returns:

```json
{ "data": <object | array>, "as_of": "2026-11-09T19:00:00.000Z", "head_seq": 1234, "next_cursor": null }
```

- `as_of`: when the daemon read the database. `head_seq`: the event log head at read time. The UI shows the age of `as_of` and shows "unknown" when the daemon is unreachable; it never fabricates state.
- Lists are paged: `?limit=` (default 50, max 200) and `?cursor=`.

Errors: `{ "error": { "code": "not_found" | "validation_failed" | "kill_switch_engaged" | "stale_hash" | "unauthorized" | "internal", "message": "...", "details": {} } }` with matching HTTP status.

## Read routes (C0 ships the first block; C2 the rest)

| Route | Returns | Notes |
|---|---|---|
| `GET /status` | `{ daemon: "up", version, started_at, kill: {engaged, engaged_at, reason, runs_to_halt, runs_halted, keys_revoked}, chain: {ok, head_seq, head_hash, verified_at, failed_seq}, spend: {today_usd, daily_cap_usd, vendors_reporting[]}, breaker: {tripped, reason}, paused_by_budget, sandbox_level, open_cards, running_runs }` | Status strip. Cheap; poll or use SSE. The UI says Stopping until `runs_halted == runs_to_halt`. |
| `GET /status-reports?kind=daily&limit=1` | `status_reports` rows, `body` parsed; self-check at `body.self_check {passed, failed_query_ids[]}` | Dawn Log. Empty until the digest stream (FW-C-023, C2). |
| `GET /policy` | `{ path, commit, sha256, text }` | Read-only Settings view. |
| `GET /session` | `{ paired_at, device_label }` | C2 with pairing. |
| `GET /projects`, `GET /projects/{id}` | `projects` rows | |
| `GET /ledger/rows?project_id=&status=&milestone=&q=` | `ledger_rows` rows | `probe` parsed. Status lives only here. |
| `GET /ledger/rows/{id}` | row plus `evidence: evidence_bundles[]`, `runs: runs[]` (summary) | |
| `GET /runs?status=&row_id=`, `GET /runs/{id}` | `runs` rows (with `cost_usd`, `sandbox_level`) | |
| `GET /runs/{id}/steps` | `run_steps` rows, seq order | Platform-written trace. |
| `GET /evidence-bundles/{id}` | `evidence_bundles` row, `bundle` parsed: `probe {exit_code, output_tail (last 4 KB, redacted), duration_ms}`, `diff {hash, files: [{path, added, removed}]}`, `policy` verdicts, `sandbox {level, controls}`, `adapter {name, version, help_sha256}` | The Captain's Table evidence view. |
| `GET /evidence-bundles/{id}/diff` | `text/x-diff`: the exact bytes whose sha256 is `bundle.diff.hash` | Covered by the approval's `payload_hash`. |
| `GET /events?after_seq=&type=&run_id=` | `events` rows | Payloads are already redacted. |
| `GET /events/stream` | SSE; `event: fw` lines carrying the event row; `id:` = seq; honors `Last-Event-ID` | Live updates. Heartbeat comment every 15 s. |
| `GET /spend?group_by=project|agent|vendor&from=&to=` | aggregates from `spend_entries` | |
| `GET /budgets` | `budgets` rows plus `spent_usd` from `budget_usage` | |
| `GET /decision-cards?status=open` | `decision_cards` rows, urgency then deadline | Inbox (C1/C2). |
| `GET /decision-cards/{id}` | card plus `approval {payload_hash, head_sha, expires_at}`, `pr {url, number, current_head_sha, head_observed_at}`, `merge_slot {held, expires_at}`, `policy {rule_id, rule_version, reason, tier}`, `files [{path, added, removed}]` | `merge_slot` and `policy` are null until C1. |
| `GET /approvals/{id}` | `approvals` row (payload_hash, head_sha, expires_at, status) | |

## Write routes (the only ones the web may call)

| Route | Body | Notes |
|---|---|---|
| `POST /approvals/{id}/respond` | approval-response.json (`decision`, `payload_hash`, `head_sha`, `method: "deck_click"`) | Stale hash or head is rejected with `stale_hash`. C1. |
| `POST /decision-cards/{id}/answer` | `{option_id}` or `{value}` | C1/C2. |
| `POST /kill-switch` / `POST /kill-switch/release` | `{reason}` | Engage works always; release is Owner only. C1. |
| `POST /ledger/rows/{id}/accept` | `{}` | Accept a proposed row (scan stream). C2. |
| `POST /decision-cards/{id}/snooze` | `{until}` | Never past the approval's `expires_at`. |
| `DELETE /session` | | Sign out. C2. |

Deny is `POST /approvals/{id}/respond` with `decision: "deny"` and a `reason_code`.

## Event types the UI should expect first

`system.started`, `system.stopped`, `system.kill_switch_engaged`, `system.kill_switch_released`, `ledger.row_created`, `ledger.row_status_changed`, `ledger.probe_executed`, `run.*` (started, succeeded, failed, killed, timed_out, artifact_verified), `evidence.bundle_created`. The closed list is the `event_types` table in `schema.core.sql`.

Spend screen: refused-by-cap dispatches are `dispatch.refused_budget`; a cap hit mid-run is `budget.hard_stop`.

## Run status labels (UI mapping, agreed)

`validating` = Checking; `killed` = Halted by you; `succeeded` with a `run_artifacts` row where `verified_by_kernel = 1` = Artifact verified; other `succeeded` = Finished, not checked; `failed` with `failure_class` in (`no_artifact`, `claim_mismatch`) = Claimed done, not verified.
