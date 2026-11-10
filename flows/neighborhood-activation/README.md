# Neighborhood activation flow

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
3 touches in 30 days → capped; host with timing below 0.5 → watch for 14 days; otherwise invite. Timing halves
every 14 days. At most 50 new invites a week per region, best fit × timing first. Each lead gets a funnel
link (host `/start/host`, a placeholder until Frequency builds it; venue `/start/partner`; builder
`/start/welcome`; resident `/start/event`) carrying persona, region, sub-area, Channel, source and utm tags.

First invites to hosts, venues and builders go by **founder email** (one to one, honest subject, who you
are, "reply no and I won't write again"). Resident posts and follow-ups go by **Frequency messaging**
(adds unsubscribe and postal address). Neither is automatic: fwd never sends.

## Spend cap and engine

`max_usd` 5 and `max_turns` 200 per week; a used-up cap pauses the flow first. Engine: ChatGPT sign-in
through the Codex CLI (`FW_CODEX_AUTH=signin`), OpenAI API key as fallback.

## Not in this row

Filling `state.json` from Frequency and lead research, the drafting runs (Codex adapter, WS-P1-015), write
routes for opening regions and recording touches, and approval cards (FW-C-010, FW-C-021).
