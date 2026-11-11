# Email approval queue

The flow keyed `email-queue` (stream S9 of the beta channels work order). Claude or ChatGPT posts a list email
here and it waits in the drafts inbox with its facts check beside the text. It never sends. Row: FW-C-113.
Probe: `pnpm probe flows/email-queue`.

## Posting

`POST /v1/flows/email-queue/drafts { asset, subject, body, audience }` with the Owner's token. `asset` is the
`utm_content` slug and the draft id (posting the same asset again replaces it). `audience` is one of the
opted-in lists in `config.json`. The answer is the stored draft.

## The facts check

The draft gate (`flows/draft-gate.ts`) plus the email rules in `flows/email-queue.ts`:

- every frequencylocal.com link carries `utm_source=email`, `utm_medium=email`, a campaign from the config and
  `utm_content=<asset>`;
- no link to a path that is not live yet (`closed_paths`: `/launch`, `/for/`, `/start/host`);
- no typed price (point to /pricing), and no date but January 31, 2027;
- an opt-out line (reply no, or unsubscribe);
- a list whose members opted in.

Numbers come only from `$FW_HOME/facts.json`, or from `facts_fallback` until Frequency serves the sheet.
A draft that breaks a rule is stored `gate_blocked` with the reasons.

## Sending

Nothing here sends. Each queue draft is a template for a list, so Approve is refused. The Owner copies it,
pastes it into Frequency Email Studio (`/admin/crm/marketing`) and sends it there to the opted-in list.
