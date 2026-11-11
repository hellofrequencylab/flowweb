# Local pulse

The flow keyed `local-pulse` (row FW-C-107, probe `pnpm probe flows/local-pulse`). Loops 4.2 and 4.3 of the launch plan: the weekly local roundup and the venue QR poster list. It never posts or sends. Every draft waits for the Owner, who sends or posts it by hand.

## What a run does

Each Thursday at 08:00 (America/Los_Angeles), or on `POST /v1/flows/local-pulse/run`:

1. Asks Frequency for the next 14 days of public events in the open sub-areas: `GET /api/webhooks/flowweb-upcoming?sub_areas=...&days=14`, signed with the outcomes secret (`crd_frequencyoutcomes`) as hex HMAC-SHA256 of `${timestamp}.${body}` (the body is empty). A good answer replaces `upcoming.json`. A failed pull keeps the last good file and records why in `pull.json`.
2. Keeps events whose town is in an open sub-area (`open_sub_areas[].towns`) and that start in the window.
3. Drafts, in the Supervisor's drafts store (`$FW_HOME/flows/local-pulse/drafts/`):
   - `members_email`: the roundup for members who opted in, with Daniel's sign-off and the P.S. opt-out line.
   - `instagram`: the caption.
   - `local_group`: one post per group with `allows_promo: true` and no post in the last `group_cooldown_days` (7). A group that bans promotion is flagged `no_promo` and gets no draft. Marking a group draft sent counts as its last post.
   - `heads_up`: one line per host featured, sent by hand.

Each event appears with its title, town, time and link (`utm_source=flowweb`, `utm_campaign=local-pulse`, `utm_content=<niche>.<draft id>`). Links become Frequency short links when the outcomes secret is set. No dashes, no member counts. A draft the Owner edited or sent is never overwritten by a later run.

## Files

- `stream.json`: the digest stream, ships disabled, tier L1.
- `config.json`: open sub-areas, groups (`name`, `url`, `allows_promo`, `last_posted_at`) and venues. The groups and venues here are placeholders. Put the real ones in `$FW_HOME/flows/local-pulse/config.json`, which wins.
- `$FW_HOME/flows/local-pulse/upcoming.json`: the last good events (also the fallback when Frequency cannot be reached).
- `$FW_HOME/flows/local-pulse/venues.json`: `{ venues: [{ venue, source_tag, poster_dropped_at }] }`.

## Routes

- `GET /v1/flows/local-pulse`: open sub-areas, upcoming in-area events, last pull, last run, groups, venues.
- `POST /v1/flows/local-pulse/run`: pull and draft now.
- `GET /v1/flows/local-pulse/venues`: the poster list with `scans_7d` per `source_tag`, read from the outcomes pull when it carries `qr: [{ source_tag, scans_7d }]`, otherwise null.
- `POST /v1/flows/local-pulse/venues/{source_tag}/dropped`: marks the poster dropped (now, or `{ at }`). An unknown tag with `{ venue }` adds the venue.
