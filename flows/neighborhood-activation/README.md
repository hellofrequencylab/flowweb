# Frequency Saturation Engine

The flow keyed `neighborhood-activation`, named Frequency Saturation Engine since FW-C-096, when the local
saturation flow was rolled into it.

Markets Frequency one large region at a time. It finds hosts, venues, builders and residents, routes
each lead to the right Frequency funnel and send route, checks when the region is fully active, and
then proposes the next region. It never posts or sends: every outward item waits for the Owner. It
replaces the local saturation flow (FW-C-031). Row: FW-C-032. Probe: `pnpm probe flows/neighborhood-activation`.

## Files

- `stream.json`: the stream definition (valid against `stream-definition.json`). Ships disabled, tier L1.
- `config.json`: offer, engine, territories and sub-areas, activation targets, lead rules, funnels, send routes, sources.
- `$FW_HOME/flows/neighborhood-activation/config.json`: optional Owner override of `config.json`.
- `$FW_HOME/flows/neighborhood-activation/state.json`: opened regions, Frequency numbers, leads, do-not-contact list, spend.
- Logic: `packages/daemon/src/flows/neighborhood-activation.ts`. API: `GET /v1/flows/neighborhood-activation`.

## Regions

In the Owner's order: North County San Diego (the seed), Orange County, Inland North (the Temecula Valley, which the
Owner confirmed), San Diego. Borders count both ways. Only the newest opened region gets outreach. Earlier ones are in
upkeep, and turn active again after `upkeep_relapse_weeks` (2) below target.

## Fully active

Targets scale with population P: hosts = max(100, ceil(P / 10,000 × 0.75)); events in the next 14 days =
hosts; sub-areas covered = 80% (a sub-area is covered when its next 14 days of events span 4 of the 7
Channels); weekly active members = hosts × 10. Progress is the weakest of the four. No numbers from Frequency
reads unknown, never zero. After `hold_weeks` (4) fully active, the flow **proposes** one unopened region
bordering an opened one, first in the Owner's order. Only the Owner opens it.

## Lead routing and send routes

In order: do-not-contact → blocked; resident → post only; fit below 0.6 → drop; region not active → watch;
3 touches in its life (or 3 in 30 days) → capped; host with timing below 0.5 → watch for 14 days; otherwise invite. Timing halves
every 14 days. At most 50 new invites a week per region, best fit × timing first. Each lead gets a funnel
link (host `/start/host`, live on Frequency since 2026-11-10; venue `/start/host` too, the one DM door since FW-C-101; builder
`/start/welcome`; resident `/start/event`) carrying persona, region, sub-area, Channel, source and utm tags.

First invites to hosts, venues and builders go by **founder email** (one to one, honest subject, who you
are, "reply no and I won't write again"). Resident posts and follow-ups go by **Frequency messaging**
(adds unsubscribe and postal address). Neither is automatic: fwd never sends.

## Lead hunts (FW-C-041)

A hunt is a saved search the Owner sets up: what to look for, the region and areas, links to search
first (up to 20 listing pages), how often (`every_days`), a cap per run (`max_sends`, at most 25) and
`build` (Frequency builds a page for the event and the message carries its claim link). Routes:
`GET|POST /v1/flows/neighborhood-activation/hunts`, `DELETE .../hunts/{id}`, `POST .../hunts/{id}/run`.

A due hunt runs inside the flow's cycle. fwd writes `hunts.json` to the cycle folder; the agent answers
`leads.json` with each event, its organizer and the public page the address was found on. fwd, not the
model, decides who gets a message: a public source page is required, the do-not-contact list (URLs,
addresses or `@domain`) wins, nobody is written to twice (`state.json` `hunt_contacts`), and each hunt
keeps at most `max_sends` per run inside the weekly `max_new_invites_per_week`. Every message ends with
the host funnel link (`src=hunt`) or the `{{claim_url}}` slot, the sign-off in `config.json` `hunts`,
the source page and "Reply "no" and I won't write again". At Draft and Copilot drafts wait for the
Owner; at confirmed Autopilot they go to the outbox on the `frequency` channel with the lead attached.

## Who the hunts look for (FW-C-096)

`config.json` `hunts.audience` has two lists. `focus` is the crowd Frequency wants first: breathwork, yoga, sound
healing, transformative experiences, maker events, swaps, art, music, expression and ecstatic dance. `steer_away`
is what hunts skip even when it matches `looking_for` (programs mainly for seniors, plain craft classes). Both go
into a hunt cycle's brief. Edit them in `$FW_HOME/flows/neighborhood-activation/config.json` to retarget.

## The v2 message system (FW-C-101)

`first_map` (encinitas, carlsbad, solana-del-mar) leads the plan inside the North County region. `niches` gives
each niche 2 or 3 angles, pain point first; every draft carries `niche`, `angle` and `route`. A lead gets 3
touches for life (`leads.max_touches_per_lead`) and the flow reaches 15 new people a day by default. `seedDraft`
writes a DM with no sign-off or P.S. (aim 70 words, 40 for a follow-up, `over_cap` past 120) or an email with
the sign-off, P.S. and opt-out. Its link uses the one DM door (`dm_door`, `/start/host`, venues with
`niche=venue`), drops persona and tags `utm_medium=one-to-one`, `utm_campaign=creator-seed`,
`utm_content=<niche>.<tag>`. Hunt DMs are unsigned too (one short line names the source and the opt-out; past
120 words they count as `too_long`), but keep `utm_campaign=<hunt id>` and `utm_content=<tag>` (FW-C-054).
Hunts never fetch instagram.com or facebook.com (`fetchAllowed`; a hunt link there answers 400).

## Spend cap and engine

`max_usd` 5 and `max_turns` 200 per week; a used-up cap pauses the flow first. Engine: ChatGPT sign-in
through the Codex CLI (`FW_CODEX_AUTH=signin`), OpenAI API key as fallback.

## Not in this row

Filling `state.json` from Frequency and lead research, the drafting runs (Codex adapter, WS-P1-015), write
routes for opening regions and recording touches, and approval cards (FW-C-010, FW-C-021).
