# C1 probe pack (Tier 0, DRAFT for Owner review)

Probes for C1 rows of `ledger/backlog/CORE-BACKLOG.json`, written before the code. Probes are Tier 0:
agents never edit them (AGENTS.md rules 2 and 3; CI jobs `tier0-guard` and `probe-immutability`).
This is a draft: the Owner reviews it line by line and commits the final version.

This README covers the C1 probes drafted so far. The first three shipped it byte-identical in their
draft PRs (one PR per row); later probe PRs append their own rows.

Run one: `pnpm probe c1/<name>`, or the backlog command (`pnpm probe kernel/daemon-lifecycle` and so
on): `probes/<lane>/<name>.mjs` is a thin wrapper that runs the C1 probe, the same pattern as C0.

## Conventions

The C0 conventions hold unchanged (`probes/c0/README.md`, "Conventions"): real surfaces only (the
`fw` CLI, the daemon `fwd`, named exports of a package index, the database at
`$FW_HOME/db/fw.sqlite` read with `node:sqlite` read-only), a fresh temporary `FW_HOME` and a
scratch git repo per probe, `MISSING <probe>:` or `FAIL <probe>:` as the first output line, open
lines checked last where the order allows it, and no secret-shaped literal in this directory. The C1
probes import the helpers from `../c0/_lib.mjs`; there is no C1 copy. Fixture row codes are
`FW-C-961` to `FW-C-963`.

`fixtures/` holds helper processes used by the probes; they are not row probes.

## Probe to row map

| Probe | Row | Backlog `verify_probe` | Acceptance lines it proves |
|---|---|---|---|
| `c1/daemon-lifecycle` | WS-P1-001 | `pnpm probe kernel/daemon-lifecycle` | fwd starts and `GET /v1/status` (CLI token) says `daemon: "up"`; every listening socket fwd owns is loopback, its port refuses connections on every non-loopback address of the host, `--host 0.0.0.0` is refused; SIGTERM with nothing in flight exits 0 with `system.stopped {clean: true}`; `fw status --json` with fwd up reports `daemon: "up"` and the daemon's `started_at`; a hanging fake run started with `fw run start` while fwd is up is, after SIGTERM and before any restart, ended (failed or killed, failure_class killed) with one terminal event saying "interrupted", its lease inactive, its vendor group gone, then `system.stopped {clean: true}`; `fw status --json` with fwd down exits 0, says the daemon is down, reports `chain.head_seq` equal to the database, and leaves the database file byte-identical; a new fwd then starts on the same home |
| `c1/stream-model` | WS-P1-003 | `pnpm probe kernel/stream-model` | `fw stream add -f <file>` refuses (exit 1 or 3, reason named, no `streams` row, no `stream.created`) a definition without `budget` and one whose `budget.caps` is empty; refuses `default_tier` L3 with no approval id and with `--approval <apr_id>` naming no recorded approval; accepts L2 (cron) and L1 (manual) definitions, each stored with project, key, tier, budget and a sha256 `definition_hash`, one `stream.created` each; `fw stream list --json` lists exactly the stream ids in the database (including the backlog stream `fw ledger sync` bootstraps). The fixtures are checked against `stream-definition.json` with `@fw/contracts` first. |
| `c1/codex-conformance` | WS-P1-015 | `pnpm probe adapters/codex-conformance` | the 8-case conformance suite passes against recorded Codex CLI 0.167.0 fixtures (`packages/adapters/test/codex.test.ts`); preflight fails closed when `codex exec --help` lacks a required flag (no run with a prompt), fingerprint is the version plus sha256 of that help; the API-key lane passes `CODEX_API_KEY` by env only and refuses without it; the sign-in lane runs on the CLI's own login under `CODEX_HOME` with no key passed and is refused when `codex login status` fails; the run result and events carry no Codex event names or ids; a second run with `resume_session_id` passes `exec resume <id>` and reports the same session |
| `c1/lease-manager` | WS-P1-008 | `pnpm probe runtime/lease-manager` | a second claimant is refused while the lease is valid (no new row, no new `lease.acquired`), a different resource is still free, a heartbeat with the live token extends `expires_at`; after expiry another holder takes the resource with a larger fence token, the old lease is `expired` with one `lease.expired`, and heartbeat, release and `checkFence` with the old token are refused while the live token passes; six rounds of two real processes racing for a fresh worktree, branch or stream lease and two rounds racing for an expired one each have exactly one winner, one active row and one `lease.acquired`, the loser refused by the lease manager (not by the writer lock) |

Each lease operation runs in its own node process (`fixtures/lease-op.mjs`), which opens the store
the way fwd does and retries a held writer lock for up to 10 s, so both racers really reach the
lease manager.

## Status on main

Run on 2026-11-09 on `origin/main` (Node 22.23.4). All three fail, for the unbuilt behaviour.

| Probe | Result | First line |
|---|---|---|
| `c1/daemon-lifecycle` | FAIL | `MISSING c1/daemon-lifecycle: fw status is not a command (exit 2: ...unknown command: status)`. The health, loopback and clean-stop checks before it pass. With `fw status` skipped, the next failure is `fw run start` while fwd is up: exit 4, writer lock held (the daemon does not host runs yet). |
| `c1/stream-model` | FAIL | `MISSING c1/stream-model: fw --help lists no "fw stream add" command` |
| `c1/lease-manager` | FAIL | `MISSING c1/lease-manager: packages/ledger/src/index.ts does not export acquireLease, heartbeatLease, releaseLease, checkFence (the lease manager)` |

`c1/lease-manager` was also run against a throwaway reference implementation (not committed): it
passed in about 30 s, and failed with a `checkFence` that accepts any token.

## Decisions for the Owner

Spec gaps found while writing these probes. Each probe follows the reading in the "Probe reads it
as" column; change the probe if the Owner decides otherwise.

| # | Row | Gap | Probe reads it as |
|---|---|---|---|
| 1 | WS-P1-001 | The row says the CLI talks to fwd over a unix socket; fwd serves loopback HTTP with a CLI bearer token today (`docs/api/LOCAL-API-V1.md`). | Transport is not probed. fwd starts on a free port the probe picks; fw gets `FW_HOME` and `FW_PORT`, so a socket under `FW_HOME`, a discovery file or `FW_PORT` all work. |
| 2 | WS-P1-001 | "Recorded as interrupted": the `runs.status` and `failure_class` lists in `schema.core.sql` have no `interrupted`. | failed or killed with failure_class `killed`, plus one terminal run event whose payload contains "interrupted". Alternative: add `interrupted` to failure_class (schema change, Tier 0). |
| 3 | WS-P1-001 | No route is called "health". | `GET /v1/status` with `daemon: "up"` (the documented status strip). |
| 4 | WS-P1-001 | "Verified by port scan test". | fwd's own listening sockets (from `/proc/<pid>/fd` and `/proc/<pid>/net/tcp{,6}`) and a connect attempt on each non-loopback address of the host. No external scanner. |
| 5 | WS-P1-001 | What the `fw status` fallback must show is not specified. | A `daemon` field that is not `up`, and `chain.head_seq` (the `GET /v1/status` field) equal to the database. That ties the fallback to the same shape as the daemon answer. |
| 6 | WS-P1-001 | "In-flight runs" only exist if fwd hosts the pipeline. Today `fw run start` runs it in the CLI and is refused (exit 4) while fwd holds the writer. | `fw run start` with fwd up hands the run to fwd (the row's core_adaptation). This is a large change for a size M row; the Owner may split it. |
| 7 | WS-P1-001, WS-P1-003 | files_hint covers no CLI code (`fw status`, `fw stream add/list` live in `packages/cli`). WS-P1-003's `packages/daemon/src/streams/src/streams/` and WS-P1-008's `packages/ledger/src/leases/src/` look like doubled paths, and exporting the lease functions needs `packages/ledger/src/index.ts`. | Not a probe question; the files_hint needs fixing before an agent can work these rows without breaking rule 1. |
| 8 | WS-P1-001 | "Config loading" and "structured logging" are in the description, not in acceptance. | Not probed. |
| 9 | WS-P1-003 | No row defines how a stream is created. | `fw stream add -f <file>`, the form a later C1 row's acceptance already uses. |
| 10 | WS-P1-003 | Where the Owner approval id goes: `stream-definition.json` has no field for it (`additionalProperties: false`). Recording an approval needs an `approvals` row with an evidence bundle, which has no surface yet. | `--approval <apr_id>` on `fw stream add`. Only refusals are probed (no id; an id that is not recorded). "L3 with a recorded approval is accepted" is not probed until approvals land. |
| 11 | WS-P1-003 | "Autonomy tier above L2": `default_tier` or also `tier_caps`? Example 24 has `tier_caps` up to L5. | `default_tier` only; the fixtures leave out `tier_caps`. |
| 12 | WS-P1-003 | files_hint names `packages/contracts/src/stream.ts`, but the stream type is generated from `contracts-core` (`StreamDefinition`). | Not probed; a hand-written type would duplicate the generated one. |
| 13 | WS-P1-008 | No spec names the lease API. | `acquireLease`, `heartbeatLease`, `releaseLease`, `checkFence` exported by `@fw/ledger`, taking a Writer and the argument shapes in the probe header, with `ttl_ms`. Owner: confirm or rename. |
| 14 | WS-P1-008 | "Atomic under concurrent processes" against a single-writer store: `openStore` takes `fwd.lock`, so two processes never write at once, and the writer lock already serialises them. | The race proves the observable property (exactly one winner, one active row, one event, unique and growing fence tokens) with two real processes. It cannot catch a lease manager that skips its own transaction. If the Owner wants that proven, the probe needs an in-process concurrency case as well. |
| 15 | WS-P1-008 | The expiry sweep (expired leases marked without a new claimant) is in core_adaptation, not acceptance. The startup reconciler already expires leases. | Only expiry on takeover is probed. |
| 16 | WS-P1-015 | The row says "using API-key credentials". The Owner wants Codex runs to use the ChatGPT plan through the Codex CLI's own sign-in. Claude refuses subscription credentials (C0 question 16). | Both lanes. `auth: 'api_key'` (the default) needs `CODEX_API_KEY` injected; `auth: 'signin'` (or `FW_CODEX_AUTH=signin` for fwd) uses `codex login` under `CODEX_HOME` and no key. Owner: confirm, or drop the sign-in case to keep Codex on the API-key lane only. |
| 17 | WS-P1-015 | files_hint `packages/adapters/src/codex/src/` is a doubled path; the adapter is registered in `packages/adapters/src/index.ts`, and its fixtures and suite live under `packages/adapters/test/`. | Not a probe question. |
| 18 | WS-P1-015 | Codex has no vendor-side dollar cap and reports token usage only at the end of a turn (`turn.completed`). | The budget-cap conformance case trips at the end of the turn, from that usage. `supports_budget_cap` is false. |
