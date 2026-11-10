# Senders (outside Core)

FlowWeb Core never sends anything. At Autopilot a flow hands each finished message to the outbox
(`$FW_HOME/outbox/<flow>/<id>.json`, row FW-C-037). A sender is a small program on the Owner's Mac that
reads the outbox and delivers. No package imports a sender and fwd never runs one.

## `email.mjs`: hunt messages from your own mailbox (FW-C-042)

Hunt messages go out from your own Workspace mailbox through Gmail, one person at a time, so they read
as a note from you and replies land in your inbox. They never go through Resend, whose rules ban cold
outreach.

What it guarantees on every pass:

- Only items that carry a `lead` on a channel you routed to a mailbox. Everything else is left alone.
- Never twice: an id or an address already in `$FW_HOME/senders/email/sent.jsonl` is skipped, even if
  the item is handed off again.
- Do-not-contact (the flow's list: an address, an `@domain` or the source page) is skipped.
- The body must carry the "reply no" line and the page the address came from, or the item fails.
- Every message carries your postal address and a `List-Unsubscribe` mailto header.
- At most `per_pass` messages per pass (default 1), `daily_cap` per mailbox per day (default 15, at
  most 40), and only inside `hours`. With launchd running it every 20 minutes from 9 to 5 on weekdays,
  per_pass 1 means about 3 an hour at most, capped by the daily number.
- Items that need a claim link (`build`) are held in `held/` unless `claim.url` is set in `email.json`
  (Frequency's `https://frequencylocal.com/api/webhooks/flowweb-claim`). With it, the sender asks Frequency to
  build the event page first, signed with the shared secret from `FW_CLAIM_SECRET` or the Keychain
  (`security add-generic-password -s flowweb-claim -a frequency -w`). Built: the claim link fills the slot and
  the message goes. Unsubscribed in Frequency: `skipped/`. Refused: `failed/`. Switched off or down: it waits.

Where items go: `sent/`, `skipped/`, `held/`, `failed/` next to the outbox files, each with a `sender`
note saying why.

### Set up (once)

1. Turn on 2-Step Verification for daniel@danieltyack.com, then make an app password at
   https://myaccount.google.com/apppasswords (name it FlowWeb).
2. Put it in the Keychain (it asks for the password, so it never sits in a file or your shell history):

   ```
   security add-generic-password -s flowweb-email -a daniel@danieltyack.com -w
   ```

3. Write `~/.flowweb/senders/email.json`:

   ```json
   {
     "mailboxes": {
       "personal": { "address": "daniel@danieltyack.com", "name": "Daniel Tyack" }
     },
     "routes": { "frequency": "personal", "founder_email": "personal" },
     "postal": "Your mailing address, City, ST 00000",
     "daily_cap": 10,
     "per_pass": 1,
     "hours": { "start": 9, "end": 17, "days": [1, 2, 3, 4, 5] }
   }
   ```

   Hunt items are on the `frequency` channel today, so route it to your mailbox. To send some from
   hello@frequencylocal.com through Workspace Gmail as well, add a second mailbox and its own app
   password; an item's `lead.send_from` picks it.
4. Try one pass by hand: `node senders/email.mjs --once` from the FlowWeb folder.
5. Run it every 20 minutes with launchd: copy `app.flowweb.sender.plist` to
   `~/Library/LaunchAgents/`, change the two paths in it to your FlowWeb folder and home, then
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/app.flowweb.sender.plist`.
   Stop it with `launchctl bootout gui/$(id -u)/app.flowweb.sender`.

Keep volume low while the mailbox is new: start with `daily_cap` 5 to 10 for the first two weeks and
answer replies yourself. Anyone who replies "no" goes on the do-not-contact list
(`POST /v1/flows/neighborhood-activation/do-not-contact` with `email`).
