# fwd local API v1 (the contract @fw/web codes against)

Status: draft for C0/C2. Owner: the Core thread. The web UI codes against this file; the daemon implements it.
Subset of the full plan's `app-plan/03-contracts/API.md` section 5, same paths and names.

## Transport

- Base URL: `http://127.0.0.1:${FW_PORT:-7317}/v1`. Loopback only.
- Auth: first `fwd` start prints a pairing code. `POST /v1/pair {code}` sets an HttpOnly session cookie `fw_session`. Every other route needs it (the CLI uses a token file at `$FW_HOME/pairing/cli.token` sent as `Authorization: Bearer`). Until pairing ships (FW-C-019), dev mode `FW_DEV_NO_AUTH=1` skips it.
- JSON only. Field names are the SQLite column names from `schema.core.sql` (snake_case), unchanged. JSON columns are returned parsed.

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
| `GET /status` | `{ daemon: "up", version, started_at, kill_switch: {engaged, engaged_at, reason}, chain: {ok, head_seq, head_hash, verified_at}, sandbox_level, open_cards, running_runs }` | Status strip. Cheap; poll or use SSE. |
| `GET /projects`, `GET /projects/{id}` | `projects` rows | |
| `GET /ledger/rows?project_id=&status=&milestone=&q=` | `ledger_rows` rows | `probe` parsed. Status lives only here. |
| `GET /ledger/rows/{id}` | row plus `evidence: evidence_bundles[]`, `runs: runs[]` (summary) | |
| `GET /runs?status=&row_id=`, `GET /runs/{id}` | `runs` rows (with `cost_usd`, `sandbox_level`) | |
| `GET /runs/{id}/steps` | `run_steps` rows, seq order | Platform-written trace. |
| `GET /evidence-bundles/{id}` | `evidence_bundles` row, `bundle` parsed (probe output, diff summary, policy verdicts, hashes) | The Captain's Table evidence view. |
| `GET /events?after_seq=&type=&run_id=` | `events` rows | Payloads are already redacted. |
| `GET /events/stream` | SSE; `event: fw` lines carrying the event row; `id:` = seq; honors `Last-Event-ID` | Live updates. Heartbeat comment every 15 s. |
| `GET /spend?group_by=project|agent|vendor&from=&to=` | aggregates from `spend_entries` | |
| `GET /budgets` | `budgets` rows plus `spent_usd` from `budget_usage` | |
| `GET /decision-cards?status=open` | `decision_cards` rows, urgency then deadline | Inbox (C1/C2). |
| `GET /approvals/{id}` | `approvals` row (payload_hash, head_sha, expires_at, status) | |

## Write routes (the only four the web may call)

| Route | Body | Notes |
|---|---|---|
| `POST /approvals/{id}/respond` | approval-response.json (`decision`, `payload_hash`, `head_sha`, `method: "deck_click"`) | Stale hash or head is rejected with `stale_hash`. C1. |
| `POST /decision-cards/{id}/answer` | `{option_id}` or `{value}` | C1/C2. |
| `POST /kill-switch` / `POST /kill-switch/release` | `{reason}` | Engage works always; release is Owner only. C1. |
| `POST /ledger/rows/{id}/accept` | `{}` | Accept a proposed row (scan stream). C2. |

## Event types the UI should expect first

`system.started`, `system.stopped`, `system.kill_switch_engaged`, `system.kill_switch_released`, `ledger.row_created`, `ledger.row_status_changed`, `ledger.probe_executed`, `run.*` (started, succeeded, failed, killed, timed_out, artifact_verified), `evidence.bundle_created`. The closed list is the `event_types` table in `schema.core.sql`.
