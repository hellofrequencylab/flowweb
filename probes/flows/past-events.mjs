// Probe for FW-C-154 (a draft never points at an event that has passed): `pnpm probe flows/past-events`.
// probe-timeout-s: 180
// Tier 0.
// Surfaces: screenLeads, parseLeads and newHunt in packages/daemon/src/flows/hunts.ts with the shipped
// flows/neighborhood-activation/config.json; a real fwd on a fresh FW_HOME (CLI token, FW_VENDOR=fake);
// the drafts folder $FW_HOME/flows/<key>/drafts/ and $FW_HOME/flows/<key>/state.json;
// GET /v1/supervisor/flows/{key}/drafts and GET /v1/flows/{key}/today.
// Why: on 2026-11-18 the Owner had 41 waiting notes, the oldest written eight days before for events that
// had since happened, and asked never to send about something that has passed.
// The surface this probe expects:
//   A hunt lead whose event.starts_at is more than a day behind now is not drafted for; its hunt's counts
//   say past. A lead for an upcoming event, or one with no readable date, is screened as before.
//   When fwd starts, each waiting hunt draft (hunt_id set, not sent) whose event.starts_at is more than a
//   day behind, or that has no readable event date and is over 7 days old, becomes rejected with
//   retired "event_passed" or "no_event_date" and held starting with that word. Its address or contact
//   page leaves state.json hunt_contacts, so a later hunt may draft for that organizer again.
//   Drafts for upcoming events, sent drafts and template drafts are left alone.
//
// Proves, in order:
//   1. The hunt screen drops a lead whose event has passed and keeps one that is upcoming.
//   2. After fwd starts, the past and the old undated drafts are retired and say why; the rest wait.
//   3. Today offers none of the retired drafts.
//   4. The retired drafts' contacts are free again; the others, and do-not-contact, are untouched.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, freshHome, missing, probe, root } from '../c0/_lib.mjs';
import { api, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/past-events';
const ROW = 'FW-C-154';
const KEY = 'neighborhood-activation';
const DAY = 86_400_000;
const ENV = { FW_VENDOR: 'fake' };
const imp = (p) => import(pathToFileURL(join(root, p)).href);

await probe(NAME, async () => {
  const now = new Date();
  const at = (days) => new Date(now.getTime() + days * DAY).toISOString();

  // ---- 1. the hunt screen ----------------------------------------------------------------------------
  const cfg = JSON.parse(readFileSync(join(root, 'flows', KEY, 'config.json'), 'utf8'));
  const hunts = await imp('packages/daemon/src/flows/hunts.ts');
  const na = await imp('packages/daemon/src/flows/neighborhood-activation.ts');
  const hunt = hunts.newHunt(cfg, { name: 'Probe', looking_for: 'sound baths', region: cfg.seed_territory_id }, now);
  const lead = (who, starts_at) => ({
    hunt_id: hunt.id,
    event: { title: `Bath by ${who}`, starts_at, url: `https://example.com/e/${who}`, country: 'US' },
    organizer: { name: who, email: `${who}@example.com`, source_url: `https://example.com/o/${who}`, country: 'US', contact_via: 'email' },
    subject: 'A question about your sound bath',
    body: `Hi ${who}, your sound bath caught my eye and I love what you are up to!`,
  });
  const leads = hunts.parseLeads({ leads: [lead('gone', at(-3)), lead('soon', at(4)), lead('undated', null)] });
  const { kept, counts } = hunts.screenLeads({ cfg, state: na.initialState(now), hunts: [hunt], leads, now });
  const c = counts[hunt.id];
  if (c.past === undefined) missing(`screenLeads does not count past events (row ${ROW})`);
  check(c.past === 1, `the screen counted ${c.past} past events, want 1: ${JSON.stringify(c)}`);
  const names = kept.map((k) => k.lead.organizer.name).sort();
  check(JSON.stringify(names) === JSON.stringify(['soon', 'undated']), `the screen kept ${JSON.stringify(names)}`);

  // ---- 2. fwd retires what has passed ----------------------------------------------------------------
  const home = realpathSync(freshHome('past-events'));
  let f = await startFwd(home, { env: ENV });
  try {
    const r = await api(f.port, 'POST', `/v1/supervisor/flows/${KEY}/enable`, { auth: f.token });
    check(r.status === 200, `enabling ${KEY} answered ${r.status}: ${r.text.slice(0, 200)}`);
  } finally {
    await f.stop();
  }
  const base = join(home, 'flows', KEY);
  mkdirSync(join(base, 'drafts'), { recursive: true });
  const put = (id, extra = {}) =>
    writeFileSync(
      join(base, 'drafts', `${id}.json`),
      JSON.stringify({
        flow: KEY,
        id,
        hunt_id: 'hnt_probe',
        channel: 'frequency',
        send_via: 'email',
        to: `${id}@example.com`,
        name: id,
        source_url: `https://example.com/o/${id}`,
        subject: 'A question about your circle',
        body: 'Hi, I found you on https://example.com/events. If this is not for you, just reply "no" and I will not write again.',
        status: 'waiting_for_owner',
        created_at: at(-1),
        ...extra,
      }),
    );
  put('gone', { event: { title: 'Gone', starts_at: at(-5), url: 'https://example.com/e/gone' }, created_at: at(-8) });
  put('form-gone', { send_via: 'contact_form', to: null, contact_url: 'https://example.com/contact', event: { title: 'Gone too', starts_at: at(-2), url: 'https://example.com/e/f' } });
  put('undated-old', { event: { title: 'No date', starts_at: null, url: 'https://example.com/e/u' }, created_at: at(-9) });
  put('undated-new', { event: { title: 'No date', starts_at: null, url: 'https://example.com/e/n' } });
  put('soon', { event: { title: 'Soon', starts_at: at(3), url: 'https://example.com/e/soon' } });
  put('sent', { event: { title: 'Sent', starts_at: at(-5), url: 'https://example.com/e/sent' }, sent_at: at(-6), created_at: at(-7) });
  writeFileSync(
    join(base, 'drafts', 'template.json'),
    JSON.stringify({ flow: KEY, id: 'template', lead_id: 'template:host', channel: 'founder_email', subject: 'Hello', body: 'Hi', status: 'waiting_for_owner', created_at: at(-20) }),
  );
  const sp = join(base, 'state.json');
  const state = existsSync(sp) ? JSON.parse(readFileSync(sp, 'utf8')) : na.initialState(now);
  const contact = { at: at(-8), hunt_id: 'hnt_probe', event_url: 'https://example.com/e' };
  writeFileSync(
    sp,
    JSON.stringify({
      ...state,
      do_not_contact: ['never@example.com'],
      hunt_contacts: {
        'gone@example.com': contact,
        'https://example.com/contact': contact,
        'undated-old@example.com': contact,
        'soon@example.com': contact,
        'sent@example.com': contact,
      },
    }),
  );

  f = await startFwd(home, { env: ENV });
  try {
    const call = (method, path) => api(f.port, method, path, { auth: f.token });
    const d = await call('GET', `/v1/supervisor/flows/${KEY}/drafts`);
    check(d.status === 200, `GET drafts answered ${d.status}: ${d.text.slice(0, 200)}`);
    const list = d.json?.data?.drafts ?? d.json?.data ?? [];
    const by = Object.fromEntries(list.map((x) => [x.id, x]));
    for (const [id, why] of [['gone', 'event_passed'], ['form-gone', 'event_passed'], ['undated-old', 'no_event_date']]) {
      check(by[id]?.status === 'rejected', `${id} is ${by[id]?.status}, want rejected (retired)`);
      check((by[id]?.held ?? '').startsWith(`${why}:`), `${id} does not say why: held is ${JSON.stringify(by[id]?.held)}`);
      const doc = JSON.parse(readFileSync(join(base, 'drafts', `${id}.json`), 'utf8'));
      check(doc.retired === why, `${id} on disk has retired ${JSON.stringify(doc.retired)}, want ${why}`);
    }
    for (const id of ['soon', 'undated-new', 'sent', 'template'])
      check(by[id]?.status === 'waiting_for_owner', `${id} was changed to ${by[id]?.status}`);

    // ---- 3. Today ------------------------------------------------------------------------------------
    const t = await call('GET', `/v1/flows/${KEY}/today`);
    check(t.status === 200, `GET today answered ${t.status}: ${t.text.slice(0, 200)}`);
    const ids = (t.json?.data?.actions ?? []).map((a) => a.draft_id);
    check(ids.includes('soon'), `Today lost the upcoming draft: ${JSON.stringify(ids)}`);
    for (const id of ['gone', 'form-gone', 'undated-old'])
      check(!ids.includes(id), `Today still offers ${id}: ${JSON.stringify(ids)}`);
  } finally {
    await f.stop();
  }

  // ---- 4. contacts ---------------------------------------------------------------------------------------
  const after = JSON.parse(readFileSync(sp, 'utf8'));
  const keys = Object.keys(after.hunt_contacts ?? {}).sort();
  check(
    JSON.stringify(keys) === JSON.stringify(['sent@example.com', 'soon@example.com']),
    `hunt_contacts after the retire: ${JSON.stringify(keys)}`,
  );
  check(JSON.stringify(after.do_not_contact) === JSON.stringify(['never@example.com']), 'do_not_contact changed');
});
