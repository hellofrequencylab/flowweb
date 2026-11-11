// Probe for FW-C-112 (the Creator seed flow launches with the Owner's 2026-11-11 defaults: two touches for
// a cold lead, email off and only to opted-in addresses, and a ref on every tagged link):
// `pnpm probe flows/launch-defaults`.
// probe-timeout-s: 120
// Tier 0.
// Surfaces: flows/neighborhood-activation/config.json as shipped (no config.json in $FW_HOME), a real fwd on
// a fresh FW_HOME (CLI token), the drafts folder $FW_HOME/flows/<key>/drafts/, the outbox
// $FW_HOME/outbox/<key>/, packages/daemon/src/flows/neighborhood-activation.ts (seedDraft) and
// packages/daemon/src/overseer/drafts.ts (refLinks), packages/daemon/src/overseer/intensity.ts.
// The surface this probe expects:
//   config.json: sequence.email_batch_approval false, sequence.cold_max_touches 2, sequence.email_opt_in_only
//   true; leads.max_touches_per_lead stays 3 and leads.max_new_contacts_per_day stays 15.
//   DEFAULT_INTENSITY.per_day stays 10.
//   A cold lead is one whose first touch came from a hunt (hunt_id) and that no draft marked warm
//   (warm true). It stops after cold_max_touches: GET /v1/flows/{key}/sequence shows it closed and never
//   due, and GET /v1/flows/{key}/today leaves its waiting draft off. A warm lead still gets touch 3.
//   With email_opt_in_only, an email touch is offered only to a lead with an opt-in marker
//   (opted_in_at, or opt_in true); POST /v1/flows/{key}/batch/approve refuses an email draft without one
//   (no_opt_in), and with email_batch_approval false nothing reaches the outbox.
//   seedDraft links keep utm_source=flowweb and carry ref=<tag>; refLinks(text, tag) adds ref=<tag> to a
//   flowweb link that has none, keeps one that has, and leaves other links alone.
//
// Proves, in order:
//   1. The shipped config and intensity carry the launch defaults, and the lifetime and daily caps stay.
//   2. A cold lead with two touches sent is closed and not due; a warm lead with two is due for touch 3.
//   3. A cold DM lead with a public email but no opt-in keeps its DM route for touch 2; one that opted in
//      is offered email.
//   4. Today leaves off the cold lead's waiting draft and keeps the warm lead's.
//   5. The batch refuses an email draft with no opt-in; an opted-in one is not handed off while email
//      batch approval is off; the outbox stays empty.
//   6. Seed links and tagged links carry ref=<tag> and keep utm_source=flowweb.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, freshHome, missing, probe, root } from '../c0/_lib.mjs';
import { api, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/launch-defaults';
const KEY = 'neighborhood-activation';
const DAY = 86_400_000;
const imp = (p) => import(pathToFileURL(join(root, p)).href);

await probe(NAME, async () => {
  // ---- 1. the shipped config -----------------------------------------------------------------------
  const cfg = JSON.parse(readFileSync(join(root, 'flows', KEY, 'config.json'), 'utf8'));
  const seq = cfg.sequence ?? {};
  if (seq.cold_max_touches === undefined) missing('config.json has no sequence.cold_max_touches (row FW-C-112)');
  check(seq.email_batch_approval === false, `sequence.email_batch_approval is ${seq.email_batch_approval}, want false`);
  check(seq.cold_max_touches === 2, `sequence.cold_max_touches is ${seq.cold_max_touches}, want 2`);
  check(seq.email_opt_in_only === true, `sequence.email_opt_in_only is ${seq.email_opt_in_only}, want true`);
  check(cfg.leads.max_touches_per_lead === 3, `leads.max_touches_per_lead is ${cfg.leads.max_touches_per_lead}, want 3`);
  check(cfg.leads.max_new_contacts_per_day === 15, `leads.max_new_contacts_per_day is ${cfg.leads.max_new_contacts_per_day}`);
  const intensity = await imp('packages/daemon/src/overseer/intensity.ts');
  check(intensity.DEFAULT_INTENSITY?.per_day === 10, `DEFAULT_INTENSITY.per_day is ${intensity.DEFAULT_INTENSITY?.per_day}`);

  const home = realpathSync(freshHome('launch-defaults'));
  const f = await startFwd(home);
  try {
    const call = (method, path, body) => api(f.port, method, path, { auth: f.token, body });
    check((await call('POST', `/v1/supervisor/flows/${KEY}/enable`)).status === 200, `enabling ${KEY} failed`);
    const drafts = join(home, 'flows', KEY, 'drafts');
    mkdirSync(drafts, { recursive: true });
    check(!existsSync(join(home, 'flows', KEY, 'config.json')), 'FW_HOME has its own config.json; the shipped one is under test');
    const now = Date.now();
    const ago = (d) => new Date(now - d * DAY).toISOString();
    const put = (id, extra = {}) =>
      writeFileSync(
        join(drafts, `${id}.json`),
        JSON.stringify({
          flow: KEY,
          id,
          hunt_id: 'hnt_launch',
          channel: 'frequency',
          send_via: 'social_dm',
          to: null,
          contact_url: `https://example.com/${id}`,
          source_url: 'https://example.com/events',
          subject: 'A question about your circle',
          body: 'Hi, I found you on https://example.com/events. If this is not for you, just reply "no" and I will not write again.',
          status: 'waiting_for_owner',
          created_at: ago(0.5),
          ...extra,
        }),
      );
    put('cold-a', { sequence_lead: 'lead-cold', sent_at: ago(10), created_at: ago(10) });
    put('cold-b', { sequence_lead: 'lead-cold', sent_at: ago(5), created_at: ago(5) });
    put('cold-c', { sequence_lead: 'lead-cold' });
    put('warm-a', { sequence_lead: 'lead-warm', warm: true, sent_at: ago(12.5), created_at: ago(13) });
    put('warm-b', { sequence_lead: 'lead-warm', warm: true, sent_at: ago(7.4), created_at: ago(8) });
    put('warm-c', { sequence_lead: 'lead-warm', warm: true });
    put('dm-a', { sequence_lead: 'lead-dm', public_email: 'dm@example.com', sent_at: ago(5.2), created_at: ago(6) });
    put('opt-a', { sequence_lead: 'lead-opt', public_email: 'opt@example.com', opted_in_at: ago(30), sent_at: ago(5.2), created_at: ago(6) });

    // ---- 2. two touches for a cold lead, three for a warm one --------------------------------------
    const r = await call('GET', `/v1/flows/${KEY}/sequence`);
    check(r.status === 200, `GET sequence answered ${r.status}: ${r.text.slice(0, 200)}`);
    const due = r.json?.data?.due ?? [];
    const leads = Object.fromEntries((r.json?.data?.leads ?? []).map((l) => [l.lead, l]));
    const dueOf = (lead) => due.find((d) => d.lead === lead);
    check(!dueOf('lead-cold'), `a cold lead with two touches is due again: ${JSON.stringify(dueOf('lead-cold'))}`);
    check(leads['lead-cold']?.state === 'closed', `a cold lead with two touches is ${JSON.stringify(leads['lead-cold'])}`);
    check(dueOf('lead-warm')?.n === 3, `a warm lead with two touches is not due for touch 3: ${JSON.stringify(due)}`);

    // ---- 3. email only for an opted-in lead ----------------------------------------------------------
    check(dueOf('lead-dm')?.n === 2 && dueOf('lead-dm')?.route === 'social_dm', `a cold DM lead without opt-in: ${JSON.stringify(dueOf('lead-dm'))}`);
    check(dueOf('lead-opt')?.route === 'email', `an opted-in lead is not offered email: ${JSON.stringify(dueOf('lead-opt'))}`);

    // ---- 4. Today follows the cold cap ---------------------------------------------------------------
    const t = await call('GET', `/v1/flows/${KEY}/today`);
    check(t.status === 200, `GET today answered ${t.status}: ${t.text.slice(0, 200)}`);
    const ids = (t.json?.data?.actions ?? []).map((a) => a.draft_id);
    check(!ids.includes('cold-c'), `Today offers a third touch to a cold lead: ${JSON.stringify(ids)}`);
    check(ids.includes('warm-c'), `Today dropped the warm lead's third touch: ${JSON.stringify(ids)}`);

    // ---- 5. the batch refuses email without opt-in, and sends nothing while it is off ----------------
    put('mail-cold', { send_via: 'email', to: 'cold@example.com', contact_url: null });
    put('mail-opt', { send_via: 'email', to: 'yes@example.com', contact_url: null, opted_in_at: ago(20) });
    const b = await call('POST', `/v1/flows/${KEY}/batch/approve`, { draft_ids: ['mail-cold', 'mail-opt'] });
    check(b.status === 200, `batch approve answered ${b.status}: ${b.text.slice(0, 300)}`);
    const refused = Object.fromEntries((b.json?.data?.refused ?? []).map((x) => [x.id, x.reason]));
    check(/^no_opt_in/.test(refused['mail-cold'] ?? ''), `an email draft with no opt-in was not refused: ${b.text.slice(0, 300)}`);
    check(!(b.json?.data?.handed_off ?? []).length, `a draft was handed off with email batch approval off: ${b.text.slice(0, 300)}`);
    const outDir = join(home, 'outbox', KEY);
    const out = existsSync(outDir) ? readdirSync(outDir).filter((x) => x.endsWith('.json')) : [];
    check(out.length === 0, `the outbox holds ${out.length} files with email off`);
  } finally {
    await f.stop();
  }

  // ---- 6. ref on every tagged link ---------------------------------------------------------------------
  const na = await imp('packages/daemon/src/flows/neighborhood-activation.ts');
  const lead = { id: 'h1', name: 'Tide', kind: 'host', niche: 'sound', territory_id: cfg.seed_territory_id, sub_area: 'encinitas', source: 'event_listings', fit: 0.9, timing: 0.9, touches: [] };
  const dm = na.seedDraft(cfg, lead, { route: 'dm', tag: 'd9q1', opener: 'Hi Tide, I love your baths!' });
  const u = new URL(dm.link);
  check(u.searchParams.get('ref') === 'd9q1', `a seed link has ref ${u.searchParams.get('ref')}: ${dm.link}`);
  check(u.searchParams.get('utm_source') === 'flowweb', `a seed link lost utm_source: ${dm.link}`);
  const drafts = await imp('packages/daemon/src/overseer/drafts.ts');
  if (typeof drafts.refLinks !== 'function') missing('drafts.ts does not export refLinks (row FW-C-112)');
  const text = 'One https://frequencylocal.com/start/host?utm_source=flowweb&utm_content=t1. Two https://frequencylocal.com/e?utm_source=flowweb&ref=keep and https://example.com/x';
  const tagged = drafts.refLinks(text, 't1');
  const links = tagged.split(/\s+/).filter((w) => w.startsWith('https://')).map((w) => w.replace(/[.,]+$/, ''));
  check(new URL(links[0]).searchParams.get('ref') === 't1', `refLinks did not add ref: ${tagged}`);
  check(new URL(links[0]).searchParams.get('utm_source') === 'flowweb', `refLinks lost utm_source: ${tagged}`);
  check(new URL(links[1]).searchParams.get('ref') === 'keep', `refLinks replaced an existing ref: ${tagged}`);
  check(tagged.endsWith('https://example.com/x'), `refLinks changed another site's link: ${tagged}`);
});
