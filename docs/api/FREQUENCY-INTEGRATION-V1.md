# FlowWeb and Frequency: integration contract v1

Row FW-C-100. Code: `hosted/server/frequency-link.mjs`. Plan and reasoning: the Owner's plan doc
"FlowWeb as a Frequency plugin" (2026-11-11). Status lives in the ledger, never here.

FlowWeb is a standalone app. Frequency is its deepest integration and never a dependency: a FlowWeb business
with no Frequency link runs exactly as it does today. One Frequency Space, the house (root Space) included, links
to one FlowWeb business. Each link has its own secret.

## Rules that hold everywhere

- FlowWeb only drafts. Nothing either side hands the other ever sends without a person approving it; anything
  FlowWeb gives Frequency to send enters Frequency's outbound approval spine as a draft.
- Outcomes are counts only: no names, emails or profile ids leave Frequency in a pull. Host events may carry
  `first_name` (the host is the Space's own member and the rescue draft greets them).
- An outcomes read that fails answers 500, never zeros, because FlowWeb learns from the numbers.
- Each Space sees only its own leads, links and numbers.

## Signing (both directions)

| Header | Value |
| --- | --- |
| `x-flowweb-timestamp` | Unix seconds when signed |
| `x-flowweb-signature` | hex HMAC-SHA256 of `${timestamp}.${body}` |
| `x-flowweb-link` | the link id (`fwl_...`) whose secret signed it; absent for the house's global secret |

A request with `x-flowweb-link` is checked only against that link's secret, never the global one. A request
without it is checked only against the global secret (`FLOWWEB_OUTCOMES_SECRET` today), so the house keeps
working until it moves onto a link. Refusals: `unsigned`, `stale` (over 300 s from now either way),
`unknown_link`, `paused`, `bad_signature`.

## Frequency to FlowWeb (served by the flowweb.app server, never by a runner)

| Route | When | Body or answer |
| --- | --- | --- |
| `POST /v1/plugin/links` | A Space turns FlowWeb on | `{ space_id, name, slug, owner_email }` -> `{ link, account, secret }` (secret shown once) |
| `POST /v1/plugin/links/{link}/events` | Lifecycle and funnel events, as they happen | one event, below |
| `POST /v1/plugin/handoff` | Open in FlowWeb | `{ token }` -> a signed-in session in the linked business |
| `GET /v1/plugin/links/{link}/summary` | The Space console card | counts: flows running, drafts waiting, sent, replied, signed up this week |
| `GET /v1/plugin/links/{link}/drafts` | The console drafts panel | the drafts flowweb.app shows |
| `POST /v1/plugin/links/{link}/requests` | Edit, reject, rewrite, flow on/off, intensity | the request kinds flowweb.app queues; approve is never queueable |

Events land in a table beside `fw_requests` and the business's runner drains them into the flow's folder as
files. They are not FlowWeb Core event types.

### Events

Every event carries `type`, `at` (ISO date), `space_id`, and optionally `host_id` and `ref` (the draft's
`utm_content`). Only the fields listed for its type are kept.

| type | extra fields |
| --- | --- |
| `host.started` | `niche`, `town`, `first_name` |
| `launcher.stalled` | `step`, `idle` (`1h` or `1d`), `first_name` |
| `space.published` | `detail` (one title), `first_name` |
| `event.filled` | `event_title` |
| `event.rsvps_8` | `rsvps`, `non_host_rsvps`, `event_title` |
| `event.second` | none |
| `meter.80` | `meter`, `used`, `limit` |
| `host.opted_out` | none |
| `founding.purchased` | none |
| `showcase.consent` | `on` |
| `event.published` | `event_id`, `title`, `starts_at`, `town`, `niche`, `rsvp_url` (public events in open sub-areas only) |

Lifecycle events for the link itself (turned off, back on, role changed, member removed, Space renamed) use the
same route with `type` `link.paused`, `link.resumed`, `member.role`, `member.removed`, `space.renamed`.

## FlowWeb to Frequency (served by frequency-web)

| Route | Today | With a link |
| --- | --- | --- |
| `/api/webhooks/flowweb-claim` | house only | builds the claim link for the linked Space |
| `/api/webhooks/flowweb-link` | house only | short link owned by the linked Space; event share links keep `utm_content` |
| `/api/webhooks/flowweb-outcomes` | house only | counts for that Space's links, plus daily RSVP counts per event (`event_id`, `rsvps`, `non_host_rsvps`) and QR scans per `source_tag` |
| `/api/webhooks/flowweb-crm` | root Space CRM | the linked Space's CRM and Conversations |
| `/api/webhooks/flowweb-facts` | new | the facts sheet: prices and the beta end date, from the same source as /pricing |
| `/api/webhooks/flowweb-upcoming` | new | upcoming public events in open sub-areas, next 14 days: `event_id`, `title`, `starts_at`, `town`, `niche`, `rsvp_url` |

`utm_content` is `niche.tag`. Both sides split it on the first dot; a value with no dot is all tag.

## Open in FlowWeb (handoff)

Frequency's server mints a token `<payload>.<signature>`: base64url JSON `{ link, nonce, iat, exp, viewers,
claims: { space_id, profile_id, email, space_role, owner } }`, signed with the link's secret over
`handoff.<payload>`, valid 60 seconds and once. The browser goes to `flowweb.app/frequency/enter?token=...`, which
posts it to `/v1/plugin/handoff`. Refusals: `malformed`, `unknown_link`, `bad_signature`, `paused`, `expired`,
`replayed`, `no_role`.

| Frequency Space role | FlowWeb role |
| --- | --- |
| Space owner | owner |
| `admin` | admin |
| `moderator`, `editor` | helper |
| `viewer` | viewer, only when the owner allows viewers; otherwise no access |

Roles are read fresh on every handoff, and `member.role` / `member.removed` events apply changes at once.
