# @fw/web: the FlowWeb Core local web UI

Vite + React static bundle that fwd serves on 127.0.0.1. Covers backlog rows FW-C-019 to FW-C-026 as a functional, deliberately plain shell: every screen and state from `claude-design/CLAUDE-DESIGN-HANDOFF.md`, with styling kept in one swappable token file so the design system can drop in later.

## Run it

```
npm install            # or pnpm install inside the monorepo
npm run dev:mock       # mock fwd on :7317 + Vite on http://127.0.0.1:5173
```

Pairing code: `424242`. Switch scenarios at http://127.0.0.1:7317/__mock (normal, quiet, stopped, down, integrity, budget, stale-card, digest-failed, no-digest, egress), or push a new head onto PR 41 while its card is open.

Against a real fwd: `FWD_URL=http://127.0.0.1:7317 npm run dev`.

Checks: `npm run typecheck`, `npm test` (honesty rules, wire mapping), `npm run check:tokens` (no colour literals outside the token layer), `npm run build`.

## Layout

| Path                                                                                          | What                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api/wire.ts`                                                                             | fwd's wire shapes from `LOCAL-API-V1.md` (schema column names). Fields not yet agreed are marked PROPOSED and treated as optional.                                    |
| `src/api/client.ts`                                                                           | The only file that talks to fwd. Unwraps the envelope, keeps `as_of`, maps rows to screen models. Swap for the generated client when FW-C-018 lands.                  |
| `src/api/types.ts`                                                                            | Screen view models.                                                                                                                                                   |
| `src/api/live.tsx`, `resource.ts`                                                             | Connection state (Live / Updates delayed / Can't reach fwd), SSE on `/v1/events/stream`, and resources that keep the last good value but never present it as current. |
| `src/ui-kit/tokens.css`                                                                       | **The token layer. The only file with raw values.** Replace it with the design system.                                                                                |
| `src/ui-kit/base.css`                                                                         | Structure only, tokens only.                                                                                                                                          |
| `src/ui-kit/`                                                                                 | Honest values (`Fact`, `AsOf`, `ResourceView`), status labels (shape + word), `Button` with a written disabled reason.                                                |
| `src/shell/`                                                                                  | Pairing, status strip, global banner, nav (rail / bottom tabs), kill switch, shortcuts, prefs, router.                                                                |
| `src/dawn`, `table`, `evidence`, `ledger`, `projects`, `runs`, `spend`, `settings`, `rewards` | One folder per backlog row's `files_hint`.                                                                                                                            |
| `mock/`                                                                                       | Mock fwd (no dependencies) and fixtures built from `CORE-BACKLOG.json`.                                                                                               |

## Honesty rules, as built

- Every value comes with fwd's `as_of`. If fwd is unreachable or a read fails, values read **Unknown** with "Last known: X, 12 min ago" underneath. A missing field is Unknown, never 0.
- Skipped checks, never-run probes, branch-only passes and agent claims read **Not verified**. Done means a probe passed on merged code.
- Running is shown only while the lease heartbeat is under 120 s old; otherwise "No signal since 09:12".
- The empty table appears only when fwd confirms zero open cards; a load failure shows an error.
- Approve stays locked, with the reason under it, until the evidence and diff have loaded, the payload hash matches, the browser's sha256 of the diff matches the bundle, no security scan failed, fwd is reachable and the kill switch is released. A moved PR head removes Approve and shows "Changed while you were looking. Nothing was merged."
- The kill switch says Stopping until fwd reports every run halted, then Stopped.
- Nothing animates except the hold ring and the reward tick; calm mode and reduced motion remove both.

## Not done yet

- Real fwd integration (waiting on FW-C-018). The mock answers every PROPOSED field; a real daemon that omits one shows Unknown.
- `fw://` refs (check output, probe output) render as copyable text; API v1 has no web route for them.
- Row history uses the recent global event list; per-row event filtering needs `GET /events?ledger_row_id=`.
- PWA install check, Playwright keyboard-only test and axe in CI (FW-C-019 / FW-C-020 probes are Tier 0, Daniel's).
