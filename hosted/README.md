# FlowWeb live mirror (hosted)

A read-only copy of FlowWeb on your machine, at a URL you can open anywhere, behind an email
sign-in that only the owner passes.

```
your machine                                   hosted
┌──────────────────────┐   outbound only   ┌───────────────────────────┐
│ fwd (127.0.0.1 only) │◀─ fw-relay reads  │ Vercel: packages/web +    │
│ claude / codex CLIs  │   pushes ───────▶ │ api/v1.mjs  ──▶ Supabase  │
│ keys in Keychain     │                   │ (fw_mirror, RLS, auth)    │
└──────────────────────┘                   └───────────────────────────┘
```

- **fwd is unchanged.** It stays loopback-only with its pairing token and is still the only
  writer of the real database. Nothing on your machine accepts connections from the internet.
- **The relay** (`hosted/relay/fw-relay.mjs`) reads fwd's JSON read routes with the CLI token
  and pushes them every 60 s. It never copies diffs, the event stream, pairing data or keys.
- **The site** (`api/v1.mjs`) serves the same `/v1` paths the web UI already uses, from the
  copy, with fwd's own `as_of`, so the UI shows real data age. Writes (approve, kill switch,
  answer a card) answer 501: do them in FlowWeb on your machine.
- **Sign-in** is a one-time email link (Supabase Auth). Accounts are never created from the
  site. Reads are allowed by row-level security only for emails in `fw_owners`.
- **Vendor accounts and keys stay on your machine.** See Settings, "Accounts and API keys".
  The site holds no vendor credential and no service-role key.

## Set up (once)

1. Apply `supabase/migrations/0001_flowweb_mirror.sql` to the Supabase project, then add the
   owner: `insert into fw_owners(email) values (lower('<your email>'));`
2. In Supabase, Authentication, URL configuration: add `https://<your-site>/**` to the
   redirect URLs, so the email link comes back to the site.
3. Vercel project from this repo (root directory = repo root; `vercel.json` has the build).
   Environment: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (the public anon key; also used
   by the function at run time).
4. Sign in on the site, open Settings, "Add a machine", and run the command it shows in this
   repo on your machine while fwd is running. Add `--once` to push a single snapshot.
5. To keep the relay running across logins on a Mac, save the token to `~/.flowweb/relay.token`
   (mode 600) and install `relay/app.flowweb.relay.plist` (fill in the paths it names).

## Tests

`node --test hosted/test/mirror.test.mjs`. CI does not run this yet: `vitest` only covers
`packages/*/test`, and adding a step to `.github/workflows/ci.yml` is an Owner change.

## Flow controls from the site (FW-C-062)

The site can also turn a flow on or off, run it now, set its dial to Draft or Copilot, pause or resume
the Supervisor, approve a draft, save, run or remove a lead hunt, and add an address to do-not-contact.
Each one is queued in `fw_requests` and applied on the Owner's machine by the relay with the CLI token,
exactly like draft edits. Autopilot, the kill switch, budgets and policy are never queued. Apply
`supabase/migrations/0004_flowweb_flow_controls.sql` once in the Supabase SQL editor first; until then
the database refuses the new kinds and the site says it could not queue the change.

## Morning run time and people a day (FW-C-063)

Under Controls on the Flows page, each flow has a run time (Every day or Weekdays) and a number of new
people a day, with an "Adjust from replies" switch that lets the last 14 days of results move it within
the min and max. From the site these queue `flow.schedule` and `flow.intensity`, which the relay applies
through fwd. Apply `supabase/migrations/0005_flowweb_morning_intensity.sql` once in the Supabase SQL
editor first; until then the database refuses the two kinds.

## AI for each flow (FW-C-086)

Settings, "AI for each flow", picks which AI account each flow uses: Claude plan, Anthropic API key,
ChatGPT plan or OpenAI API key. Only the choice moves; keys stay in the machine's keychain. From the site it
queues `flow.ai`, which the relay applies through fwd. Apply `supabase/migrations/0007_flowweb_flow_ai.sql`
once first; until then the database refuses the kind and the site says it could not queue the change.
