# Host moments

The flow keyed `host-moments`. Frequency tells FlowWeb when something happens to a host, and this flow turns
each moment into a personal note from the Owner that waits in the drafts inbox. It never sends anything.
Row: FW-C-106. Probe: `pnpm probe flows/host-moments`.

## Files

- `stream.json`: the stream definition (template email, trigger event, tier L1). Ships off, like the other flows.
- `config.json`: the sign-off, intro line, opt-out P.S., link tags, share kit QR link, due time, facts keys.
- `$FW_HOME/flows/host-moments/events/*.json`: one Frequency event per file (integration contract v1).
  Write each file whole (temp file, then rename). A handled file moves to `events/done/`.
- `$FW_HOME/facts.json`: the facts sheet. Only `founding_price`, `founding_ends` and `plan_price` are quoted.
- `$FW_HOME/flows/host-moments/state.json`: who was thanked, stalls already noted, known events.
- Logic: `packages/daemon/src/flows/host-moments.ts`. fwd scans every 5 minutes, and Run now scans at once.

## Moments

| Event | Draft | Rule |
|---|---|---|
| `launcher.stalled` | stall nudge | Names the step and offers a 10 minute setup call. One per host per step. |
| `space.published` | thank-you | Names the payload detail, due 48 hours after the event. Carries the share kit when the host has an upcoming `event.published`. |
| `event.published` | share kit | Only when the host was already thanked and the event has no kit yet. |
| `event.filled` | referral ask | One line from the Owner and an intro the host forwards. FlowWeb never contacts the people referred. |
| `event.rsvps_8` | Founding Year note | Payload count and facts sheet only. No facts sheet, no draft, and the reason is logged. |
| `meter.80` | limit note | Payload numbers; the paid plan price only from the facts sheet. |
| `host.opted_out` | none | The host goes on the do-not-contact list in `neighborhood-activation` state.json the same day, with the lead behind `ref` when known. Their waiting drafts are held. Handled even while the flow is off. |

`host.started` and `event.published` remember the host's niche and events. Other events are filed as done.
A draft greets the host by `first_name` when the event has one, else "Hi there". Event text is data: it is
cleaned, capped and stripped of links before it fills a template. No em or en dashes reach a draft.
