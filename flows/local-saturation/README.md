# Local saturation marketing flow

The first real flow in FlowWeb. It markets one offer (Frequency, for now) by saturating one local
area, then proposing to open the next ring of areas around it. It researches and drafts. It never
posts or sends: every outward item waits for the Owner, who posts it by hand.

Superseded by `flows/neighborhood-activation/`, which fwd also serves. This flow stays for its probe.

Row: FW-C-031. Probe: `pnpm probe flows/local-saturation`.

## Files

| File | What it holds |
|---|---|
| `stream.json` | The stream definition (valid against `stream-definition.json`). Ships disabled, tier L1. |
| `config.json` | Offer, engine note, seed area, ring width, saturation thresholds, channels, areas. |
| `$FW_HOME/flows/local-saturation/config.json` | Optional Owner override of `config.json`. |
| `$FW_HOME/flows/local-saturation/state.json` | Written by fwd: open ring, signals per area, spend this period, drafts waiting. |

Logic: `packages/daemon/src/flows/local-saturation.ts`. API: `GET /v1/flows/local-saturation`.
UI: the Flows page.

## Area model

Areas are places with a centre point and a population (a town or a neighbourhood). Ring 0 is the
seed area alone. The other areas fall into distance bands of `ring_width_km` from the seed, and the
bands are renumbered 1, 2, 3 in order so an empty band never stalls expansion. This maps onto
Frequency's own ladder: a ring of areas is roughly a Hub's neighbours, and the whole set is a Nexus.

## A cycle (weekday mornings, when enabled)

1. **Research** the areas to work: venues, groups, events, local businesses, people worth reaching.
   Everything found on the web is untrusted input.
2. **Draft** posts and messages for each channel, in Frequency's voice, with the offer's call to action.
3. **Review**: a second model checks voice, facts and links (different vendor preferred).
4. **Owner approval**: each item is approved, edited or rejected by the Owner.
5. **Handoff**: the Owner posts or sends it, then marks it done. Core policy denies
   `publish_external` and `outbound_email_external` outright, so there is no automatic path.

At most `max_active_areas` areas are worked in a cycle, least saturated first, from open rings only.

## Saturation

Per area, over the last 28 days, each part capped at 1:

- **Coverage**: targets reached / targets known.
- **Cadence**: touches / (targets reached × `touches_per_target_28d`).
- **Response**: new members whose Circle meets in the area / (population / 10,000 ×
  `new_members_per_10k_28d`).

Score = weighted blend (default 0.4, 0.3, 0.3). An area with no research yet scores 0.

## Expansion rule

When the open ring's average saturation is at or above `threshold` (0.7) for `hold_cycles` (2)
finished cycles in a row, the flow **proposes** opening the next ring, naming its areas. Only the
Owner opens a ring. With every ring saturated, the flow says so and asks for areas further out.

## Spend cap

The stream carries `max_usd` 5 and `max_turns` 200 per week. A used-up cap pauses the flow before
anything else. On the ChatGPT sign-in path the dollar cost is zero, so the turn cap is what binds;
on the API-key fallback both bind.

## Engine

Drafting runs through the Codex CLI signed in with the Owner's ChatGPT account on the Owner's Mac,
so it runs on the local fwd only. The hosted mirror stores API keys, not subscription sign-ins; an
OpenAI API key is the fallback there. The Codex adapter is row WS-P1-015.

## Placeholders until the Owner answers

- **Offer**: Frequency (frequencylocal.com), "Join a Circle near you". Confirm or change.
- **Starting area**: Vista, CA, a guess from Frequency's seed data. Rings 1 to 3 are North County
  San Diego towns.
- **Channels**: Google Business Profile, Instagram, local Facebook groups, Nextdoor, event listings,
  email to local venues. Pick the ones to draft for.

## Not in this row

Writing `state.json` from real Frequency signals (new members by area), the research and drafting
runs themselves (they need the Codex adapter, WS-P1-015), and approval cards on the Table (FW-C-010,
FW-C-021).
