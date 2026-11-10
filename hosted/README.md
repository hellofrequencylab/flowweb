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
- **Sign-in** (FW-C-080, `packages/web/src/hosted/auth.ts`): email and password, a one-time
  email link, or Google when `VITE_FW_AUTH_GOOGLE` is on, plus a password reset. Anyone can
  make a login. Every error shown is one of our own sentences, never Supabase's text. What a
  login may read is decided by row-level security (accounts and roles: FW-C-083).
- **Vendor accounts and keys stay on your machine.** See Settings, "Accounts and API keys".
  The site holds no vendor credential and no service-role key.

## Set up (once)

1. Apply `supabase/migrations/0001_flowweb_mirror.sql` to the Supabase project, then add the
   owner: `insert into fw_owners(email) values (lower('<your email>'));`
2. In Supabase, Authentication, URL configuration: set the site URL and add
   `https://<your-site>/**` to the redirect URLs, so email links and Google come back to the
   site. Under Sign In / Providers: Email on (with "Confirm email"), and for Google add the
   OAuth client ID and secret from Google Cloud (its authorized redirect URI is
   `https://<project-ref>.supabase.co/auth/v1/callback`), then set `VITE_FW_AUTH_GOOGLE=1`
   in Vercel.
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

## Setup assistant (FW-C-085)

Get started has a setup assistant that walks a new person through putting FlowWeb on their machine and
connecting their own AI account there (`pnpm fw accounts connect`). Keys stay in that machine's keychain;
the site never receives one, and anything typed that looks like a key is refused before it is sent.
To let it answer free questions with Claude, add `FW_ASSISTANT_ANTHROPIC_KEY` to the Vercel project's
environment (Production), using an Anthropic API key made for this site. Without it the assistant still
guides every step and answers common questions from what it knows. Questions and answers are not stored.

## Businesses, members and roles (FW-C-083)

`supabase/migrations/0006_flowweb_accounts.sql` turns the single-owner mirror into businesses
(accounts). Each login can make businesses and be invited into others, as admin, helper or
viewer, for the whole business or only named flows (helpers and viewers). Roles: owner
(everything), admin (people, machines, flow controls, drafts), helper (works drafts), viewer
(reads only). `server/accounts.mjs` holds the same table for the screens; the database decides.

- Everything the site keeps (mirror, machines, queued requests) carries `account_id`, and row
  level security reads by membership. A machine token belongs to one business, so a relay only
  replaces and takes its own business's rows.
- Running 0006 moves what is there now into one business, "My FlowWeb", owned by the logins in
  `fw_owners`. The existing relay token keeps working; nothing changes on the Mac.
- Order matters: deploy the /v1 that understands businesses first, then run 0006. The older /v1
  calls `fw_is_owner` and the old `fw_request` signature, which 0006 replaces.
