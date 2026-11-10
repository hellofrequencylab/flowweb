# fwd local API v1 (the contract @fw/web codes against)

Status: implemented in C0 for the read routes and `POST /pair`, in C1 `POST /runs` for the CLI (see packages/daemon/README.md); other writes return 501 until their rows land. Owner: the Core thread. The web UI codes against this file; the daemon implements it.
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

Errors: `{ "error": { "code": "not_found" | "validation_failed" | "kill_switch_engaged" | "stale_hash" | "unauthorized" (401) | "forbidden" (403: bad Host or cross-origin write) | "method_not_allowed" (405) | "not_implemented" (501: route lands in a later row) | "unavailable" (503: fwd is stopping) | "internal", "message": "...", "details": {} } }` with matching HTTP status.

## Read routes (C0 ships the first block; C2 the rest)

| Route | Returns | Notes |
|---|---|---|
| `GET /status` | `{ daemon: "up", version, started_at, kill: {engaged, engaged_at, reason, runs_to_halt, runs_halted, keys_revoked}, chain: {ok, head_seq, head_hash, verified_at, failed_seq}, spend: {today_usd, daily_cap_usd, vendors_reporting[]}, breaker: {tripped, reason}, paused_by_budget, sandbox_level, open_cards, oldest_open_card_at, running_runs }` | Status strip. Cheap; poll or use SSE. The UI says Stopping until `runs_halted == runs_to_halt`. |
| `GET /status-reports?kind=daily&limit=1` | `status_reports` rows, `body` parsed; self-check at `body.self_check {passed, failed_query_ids[]}` | Console. Empty until the digest stream (FW-C-023, C2). |
| `GET /policy` | `{ path, commit, sha256, text }` | Read-only Settings view. |
| `GET /session` | `{ paired_at, device_label }` | C2 with pairing. |
| `GET /projects?brand=&category=`, `GET /projects/{id}` | `projects` rows, plus `brand` and `category` | `brand` matches ignoring case and outer spaces. |
| `GET /ledger/rows?project_id=&status=&milestone=&q=` | `ledger_rows` rows | `probe` parsed. Status lives only here. |
| `GET /ledger/rows/{id}` | row plus `evidence: evidence_bundles[]`, `runs: runs[]` (summary) | |
| `GET /runs?status=&row_id=`, `GET /runs/{id}` | `runs` rows (with `cost_usd`, `sandbox_level`, `artifact_verified`); `/runs/{id}` adds `artifacts[]` (`run_artifacts` rows) | |
| `GET /runs/{id}/steps` | `run_steps` rows, seq order | Platform-written trace. |
| `GET /evidence-bundles/{id}` | `evidence_bundles` row; `body` parsed (exactly `evidence-bundle.json`), plus a derived `view`: `probe {exit_code, output_tail (last 4 KB, redacted), duration_ms}`, `diff {hash, files: [{path, added, removed}]}`, `policy [{rule, verdict, detail}]`, `sandbox {level, controls}`, `adapter {name, version, help_sha256}` | The Sign-offs evidence view. `view` is computed from `body.automated_evidence`, `body.intent_payload` and `body.provenance`; any part the bundle does not prove is null. |
| `GET /evidence-bundles/{id}/diff` | `text/x-diff`: the exact bytes whose sha256 is `body.intent_payload.payload_hash` (= `view.diff.hash`) | Covered by the approval's `payload_hash`. |
| `GET /events?after_seq=&type=&run_id=` | `events` rows | Payloads are already redacted. |
| `GET /events/stream` | SSE; `event: fw` lines carrying the event row; `id:` = seq; honors `Last-Event-ID` | Live updates. Heartbeat comment every 15 s. |
| `GET /spend?group_by=project|agent|vendor&from=&to=` | aggregates from `spend_entries` | |
| `GET /budgets` | `budgets` rows plus `spent_usd` from `budget_usage` | |
| `GET /decision-cards?status=open` | `decision_cards` rows, urgency then deadline | Inbox (C1/C2). |
| `GET /decision-cards/{id}` | card plus `approval {payload_hash, head_sha, expires_at}`, `pr {url, number, current_head_sha, head_observed_at}`, `merge_slot {held, expires_at}`, `policy {rule_id, rule_version, reason, tier}`, `files [{path, added, removed}]` | `merge_slot` and `policy` are null until C1. |
| `GET /approvals/{id}` | `approvals` row (payload_hash, head_sha, expires_at, status) | |
| `GET /flows/{key}` | `local-saturation` or `neighborhood-activation`; other keys are 404. `local-saturation`: `{ key, name, enabled, tier, gate_on[], offer, engine, channels[], placeholders[], thresholds, open_ring, rings: [{ring, open, average, areas: [{id, name, km_from_seed, population, saturation {score, coverage, cadence, response}, signals, awaiting_owner}]}], decision {kind, summary}, plan [{area_id, reason}], steps[], budget {period, max_usd, max_turns, spent_usd, used_turns, since}, awaiting_owner_total }` | Flows page. Read from `flows/<key>/` in the repo (config may be overridden in `$FW_HOME/flows/<key>/config.json`) and `$FW_HOME/flows/<key>/state.json`. Read-only: the flow drafts, the Owner posts. |
| `GET /flows/neighborhood-activation` | `{ key, name, enabled, tier, gate_on[], offer, engine, sources[], funnels, send_routes, placeholders[], thresholds, opened[], territories: [{id, name, order, status, borders[], population, sub_areas[], targets, measures|null, progress|null, qualifies|null, weeks_at_threshold, weeks_below, leads {host, venue, builder, resident}}], leads: [{id, name, kind, territory_id, sub_area, channel, source, url, fit, timing, touches [{at, via}], stage, reason, send_via, funnel {path, persona, url}|null}], pipeline, decision {kind, territory_id?, summary}, plan {sub_areas[], invites[]}, steps[], budget, awaiting_owner_total }` | Flows page. Same files and override as above. Unknown measures are null, never zero. Expansion is only proposed; nothing is ever sent. |
| `GET /supervisor` | `{ kill_switch, paused, max_concurrent, running, gates[], flows: [{key, name, enabled, tier, state: ready\|held\|running, gate, reason, open_asks, budget {max_usd, max_turns, period, spent_usd, used_turns} \| null}], next[] }` | Flows page (FW-C-033). `gates` is the closed list, in the order checked; a held flow names exactly one, a ready or running flow names none. A cap of `null` never holds a flow. |

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

## CLI-only write routes (the web never calls these)

| Route | Body | Notes |
|---|---|---|
| `POST /runs` | `{ code, repo_dir, adapter?, scenario?, base?, host?, max_wall_clock_s? }` (`repo_dir` absolute; no other fields) | C1. `fw run start` while fwd is up: the pipeline runs inside fwd, which holds the writer. CLI token only; a browser session gets 403 `forbidden`. Answers when the run ends: the envelope with `data` = the `fw run start` report (`code, ok, run_id, status, failure_class, reason, policy_code, row_status, work_order_id, branch, worktree, pr, evidence_bundle_id, bundle_hash, sandbox_level, cost_usd, cost_estimated`); a refusal before a run starts is a report with `status: "refused"`. A kernel error answers `validation_failed` (400) or `not_found` (404) with the kernel's own code in `details.fw_code` (for example `BAD_ARGUMENT`, `NOT_FOUND`). While fwd stops it answers 503 `unavailable`, and a run in flight is interrupted: it ends `killed`, `failure_class: "killed"`, with one `run.killed` whose `detail` starts with `interrupted` (`cause: "interrupted"`), and the held request still gets that report before `system.stopped`. |
| `POST /supervisor/pause`, `POST /supervisor/resume` | — | Hold every flow (`supervisor_paused`) or free them. Answers the `GET /supervisor` view plus `changed`. One `system.config_changed` event per change (FW-C-033). |
| `POST /supervisor/flows/{key}/enable`, `.../disable` | — | Turn a shipped flow on or off; unknown key 404. Same answer and event. |

`fw status` uses `GET /status` when fwd answers. When it does not, the CLI reports the same shape read from the database read-only, with `daemon: "down"`, `source: "database"`, `started_at: null` and `chain.head_seq` = the newest event seq; it never writes the database.

## Event types the UI should expect first

`system.started`, `system.stopped`, `system.kill_switch_engaged`, `system.kill_switch_released`, `ledger.row_created`, `ledger.row_status_changed`, `ledger.probe_executed`, `run.*` (started, succeeded, failed, killed, timed_out, artifact_verified), `evidence.bundle_created`. The closed list is the `event_types` table in `schema.core.sql`.

Spend screen: refused-by-cap dispatches are `dispatch.refused_budget`; a cap hit mid-run is `budget.hard_stop`.

## Run status labels (UI mapping, agreed)

`validating` = Checking; `killed` = Halted by you; `succeeded` with a `run_artifacts` row where `verified_by_kernel = 1` = Artifact verified; other `succeeded` = Finished, not checked; `failed` with `failure_class` in (`no_artifact`, `claim_mismatch`) = Claimed done, not verified.

## Notes from the C0 implementation

- `running_runs` counts `starting`, `running` and `validating`.
- A run's `sandbox_level` is not a column; it comes from the run's `run.started` event payload.
- No CORS headers are sent. A dev web server on another port must proxy `/v1` and rewrite `Host` to `127.0.0.1:<port>`.
- Ledger rows: `probe_spec`, `probe_expected`, `links` and `depends_on` are returned parsed (there is no single `probe` column).
- Fields added for the web UI (were PROPOSED in its `wire.ts`): `status.oldest_open_card_at`; projects carry `rows_open` (open, ready), `rows_in_progress` (claimed to merging) and `rows_waiting_on_owner` (awaiting_approval, blocked); `/ledger/rows/{id}` adds `last_run_id` and `events[]` (the 50 newest events whose payload names the row); runs carry `artifact_verified` and `/runs/{id}` `artifacts[]`; decision cards carry `project_name`.
- Project labels: `brand` (free text, for example `Frequency`) and `category` (`marketing`, `product`, `ops`, `sales`, `support`, `finance`, `other`), both null when unset. They live in one JSON document in `settings('project_labels')`, keyed by project id, so they needed no schema change. Set them with `fw project label <project> --brand <b> --category <c>`; each change writes one `project.updated` event. The hosted mirror filters on both.
- Still not served, because C0 records no data for them: row `description`, `blocked_reason`, `acceptance[]`, `last_probe_sha/target/output_ref`; run `agent_role`, `model`, `cost_estimated` (owner question 14), `verifier`; step `label`, `excerpt`, `denied_by_policy`, `untrusted`; evidence view `tests_removed_or_skipped`, `tokens`, `verifier_summary`; approval `current_head_sha`, `merge_slot`, `cost_usd`; spend `vendors_reporting/vendors_total` as counts (status already lists `vendors_reporting[]` by name).
