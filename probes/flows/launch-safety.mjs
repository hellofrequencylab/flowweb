// Probe for FW-C-117 (launch safety fixes from the 2026-11-11 audit): `pnpm probe flows/launch-safety`.
// probe-timeout-s: 120
// Tier 0.
// Surfaces: a real fwd on a fresh FW_HOME (CLI token) with flows/neighborhood-activation as shipped; the drafts
// folders $FW_HOME/flows/<key>/drafts/, the outbox $FW_HOME/outbox/<key>/ and the do-not-contact list in
// $FW_HOME/flows/neighborhood-activation/state.json; packages/daemon/src/flows/live-links.ts (livePath,
// funnelsLive), host-moments.ts (scanEvents with flows/host-moments/config.json as shipped), hunts.ts
// (funnelLink), reply-helper.ts (loadTree, compose), event-intake.ts (fetchCalendar) and draft-gate.ts
// (checkDraft).
// The surface this probe expects:
//   POST /v1/flows/{key}/batch/approve refuses, with a reason each, a gate_blocked draft (gate_blocked), a
//   draft whose address is on do-not-contact (do_not_contact), and a draft for a UK or Canadian lead
//   (restricted_region), and hands none of them to the outbox. An unknown flow key answers 404 and writes
//   nothing.
//   A pasted "no" (POST /v1/flows/{key}/replies) moves the sender's waiting drafts to status do_not_contact.
//   POST /v1/supervisor/flows/{key}/drafts/{id}/approve answers 409 for a draft whose person is on
//   do-not-contact, and GET /v1/flows/{key}/today leaves that draft off.
//   A host.opted_out event moves the host's waiting drafts in every flow to do_not_contact.
//   funnels_live false in a flow's config (or FW_FUNNELS_LIVE=off) sends every generated /start/host,
//   /for/<niche> and /launch link to /create-a-space with the same query tags; the shipped host-moments
//   config sets it false.
//   fetchCalendar(url, now, get, { lookup }) refuses private, link-local and unique-local addresses (any
//   address the host resolves to) without fetching, and stops reading a body at its byte cap.
//   checkDraft blocks a region named Ontario or Scotland.
//
// Proves, in order:
//   1. Batch approve refuses blocked, do-not-contact, UK and Canadian drafts with reasons; nothing reaches
//      the outbox; a flow key that is not shipped is refused before the filesystem.
//   2. An opt-out reaches waiting drafts: a pasted no, the do-not-contact list in approve and Today, and a
//      host.opted_out event.
//   3. Live links only while funnels_live is false; today's links when it is true.
//   5. Calendar fetches refuse private addresses and stop at the byte cap.
//   7. Region names block in the draft gate.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, freshHome, missing, probe, root } from '../c0/_lib.mjs';
import { api, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/launch-safety';
const KEY = 'neighborhood-activation';
const LINK = 'https://frequencylocal.com/x?utm_source=flowweb&utm_content=sound.t1';
const imp = (p) => import(pathToFileURL(join(root, p)).href);

await probe(NAME, async () => {
  const home = realpathSync(freshHome('launch-safety'));
  const f = await startFwd(home);
  try {
    const call = (method, path, body) => api(f.port, method, path, { auth: f.token, body });
    check((await call('POST', `/v1/supervisor/flows/${KEY}/enable`)).status === 200, `enabling ${KEY} failed`);
    const flowDir = (k) => join(home, 'flows', k);
    const draftPath = (k, id) => join(flowDir(k), 'drafts', `${id}.json`);
    const read = (k, id) => JSON.parse(readFileSync(draftPath(k, id), 'utf8'));
    const put = (k, id, extra = {}) => {
      mkdirSync(join(flowDir(k), 'drafts'), { recursive: true });
      writeFileSync(
        draftPath(k, id),
        JSON.stringify({
          flow: k,
          id,
          channel: 'email',
          send_via: 'email',
          to: `${id}@example.com`,
          subject: 'A question about your circle',
          body: `Hi, a note from Daniel. ${LINK}`,
          status: 'waiting_for_owner',
          opted_in_at: new Date(Date.now() - 86_400_000).toISOString(),
          created_at: new Date().toISOString(),
          ...extra,
        }),
      );
    };
    mkdirSync(flowDir(KEY), { recursive: true });
    writeFileSync(join(flowDir(KEY), 'state.json'), JSON.stringify({ do_not_contact: ['listed@example.com', '@blocked.org'] }));

    // ---- 1. batch approve refuses blocked, do-not-contact and restricted drafts ------------------------
    put(KEY, 'blocked', { status: 'gate_blocked', gate: { blocks: [{ code: 'dash', detail: 'it has an em or en dash' }] } });
    put(KEY, 'dnc', { to: 'listed@example.com' });
    put(KEY, 'dncdomain', { to: 'anyone@blocked.org' });
    put(KEY, 'uk', { to: 'host@studio.co.uk', country: 'GB' });
    put(KEY, 'ca', { to: 'host@gmail.com', region: 'Ontario' });
    const b = await call('POST', `/v1/flows/${KEY}/batch/approve`, { draft_ids: ['blocked', 'dnc', 'dncdomain', 'uk', 'ca'] });
    check(b.status === 200, `batch approve answered ${b.status}: ${b.text.slice(0, 300)}`);
    const refused = Object.fromEntries((b.json?.data?.refused ?? []).map((x) => [x.id, x.reason]));
    const want = { blocked: /^gate_blocked/, dnc: /^do_not_contact/, dncdomain: /^do_not_contact/, uk: /^restricted_region/, ca: /^restricted_region/ };
    for (const [id, re] of Object.entries(want))
      check(re.test(refused[id] ?? ''), `batch approve did not refuse ${id} with ${re}: ${b.text.slice(0, 500)}`);
    check(!(b.json?.data?.handed_off ?? []).length, `batch approve handed off ${JSON.stringify(b.json?.data?.handed_off)}`);
    const outDir = join(home, 'outbox', KEY);
    const out = existsSync(outDir) ? readdirSync(outDir).filter((x) => x.endsWith('.json')) : [];
    check(out.length === 0, `the outbox holds ${out.join(', ')}`);
    const bad = await call('POST', '/v1/flows/..%2Fescaped/batch/approve', { draft_ids: ['x'] });
    check(bad.status === 404, `batch approve on a flow key that is not shipped answered ${bad.status}`);
    check(!existsSync(join(home, 'escaped')), 'batch approve on ../escaped wrote outside the flows folder');

    // ---- 2. an opt-out reaches the person's waiting drafts --------------------------------------------
    put(KEY, 'stop-a', { to: 'stop@example.com', send_via: 'social_dm', channel: 'frequency' });
    const no = await call('POST', `/v1/flows/${KEY}/replies`, { contact: 'stop@example.com', text: 'No thanks.' });
    check(no.status === 200 && no.json?.data?.intent === 'no', `the pasted no answered ${no.status}: ${no.text.slice(0, 300)}`);
    check(read(KEY, 'stop-a').status === 'do_not_contact', `a pasted no left the waiting draft ${read(KEY, 'stop-a').status}`);

    put(KEY, 'listed-dm', { to: 'listed@example.com', send_via: 'social_dm', channel: 'frequency' });
    put(KEY, 'fine-dm', { to: 'fine@example.com', send_via: 'social_dm', channel: 'frequency' });
    const ap = await call('POST', `/v1/supervisor/flows/${KEY}/drafts/listed-dm/approve`);
    check(ap.status === 409, `approving a draft to someone on do-not-contact answered ${ap.status}: ${ap.text.slice(0, 200)}`);
    const t = await call('GET', `/v1/flows/${KEY}/today`);
    check(t.status === 200, `GET today answered ${t.status}`);
    const ids = (t.json?.data?.actions ?? []).map((a) => a.draft_id);
    check(!ids.includes('listed-dm') && !ids.includes('dnc'), `Today offers someone on do-not-contact: ${JSON.stringify(ids)}`);
    check(ids.includes('fine-dm'), `Today dropped a draft to someone not on the list: ${JSON.stringify(ids)}`);
  } finally {
    await f.stop();
  }

  // host.opted_out, with the shipped host-moments config
  const hm = await imp('packages/daemon/src/flows/host-moments.ts');
  const h2 = realpathSync(freshHome('launch-safety-hm'));
  const now = new Date('2026-11-11T18:00:00.000Z');
  const ev = (type, host, extra = {}) => ({ type, at: '2026-11-11T17:30:00.000Z', host_id: host, space_id: `s-${host}`, ref: 'sound.t1', first_name: 'Ana', ...extra });
  const drop = (name, e) => {
    mkdirSync(join(h2, 'flows', 'host-moments', 'events'), { recursive: true });
    writeFileSync(join(h2, 'flows', 'host-moments', 'events', `${name}.json`), JSON.stringify(e));
  };
  drop('a', ev('launcher.stalled', 'h1', { step: 'cover photo' }));
  drop('b', ev('launcher.stalled', 'h2', { step: 'cover photo' }));
  await hm.scanEvents({ repoRoot: root, fwHome: h2, now, draft: true });
  const hmDir = join(h2, 'flows', 'host-moments', 'drafts');
  const hmDrafts = () => readdirSync(hmDir).map((x) => JSON.parse(readFileSync(join(hmDir, x), 'utf8')));
  const stall = hmDrafts().find((d) => d.host_id === 'h1');
  check(stall, `no stall draft for h1: ${JSON.stringify(hmDrafts().map((d) => d.id))}`);
  drop('c', ev('host.opted_out', 'h1'));
  await hm.scanEvents({ repoRoot: root, fwHome: h2, now, draft: true });
  for (const d of hmDrafts()) {
    if (d.host_id === 'h1') check(d.status === 'do_not_contact', `an opted-out host's draft is ${d.status}`);
    if (d.host_id === 'h2') check(d.status === 'waiting_for_owner', `another host's draft is ${d.status}`);
  }

  // ---- 3. live links only ------------------------------------------------------------------------------
  const hmCfg = JSON.parse(readFileSync(join(root, 'flows/host-moments/config.json'), 'utf8'));
  check(hmCfg.funnels_live === false, `flows/host-moments/config.json funnels_live is ${hmCfg.funnels_live}, want false`);
  const links = String(stall.body).match(/https?:\/\/[^\s<>"')\]]+/g) ?? [];
  const door = links.map((l) => new URL(l.replace(/[.,]+$/, ''))).find((u) => u.hostname === 'frequencylocal.com');
  check(door?.pathname === '/create-a-space', `the stall note links to ${door?.pathname}: ${stall.body}`);
  check(door.searchParams.get('utm_source') === 'flowweb' && door.searchParams.get('utm_content'), `the stall link lost its tags: ${door}`);
  for (const l of links) check(!/\/(start\/host|for\/|launch)/.test(new URL(l).pathname), `a stall note link is not live: ${l}`);

  if (!existsSync(join(root, 'packages/daemon/src/flows/live-links.ts')))
    missing('packages/daemon/src/flows/live-links.ts does not exist (row FW-C-117)');
  const ll = await imp('packages/daemon/src/flows/live-links.ts');
  check(ll.livePath('/launch', false) === '/create-a-space' && ll.livePath('/for/teacher', false) === '/create-a-space', 'livePath keeps a page that is not live');
  check(ll.livePath('/pricing', false) === '/pricing' && ll.livePath('/help', false) === '/help', 'livePath moved a live page');
  check(ll.funnelsLive({ funnels_live: true }, { FW_FUNNELS_LIVE: 'off' }) === false, 'FW_FUNNELS_LIVE=off does not turn live links on');

  const cfg = JSON.parse(readFileSync(join(root, 'flows', KEY, 'config.json'), 'utf8'));
  const hunts = await imp('packages/daemon/src/flows/hunts.ts');
  const hunt = { id: 'hnt_1', region: cfg.seed_territory_id, areas: ['encinitas'] };
  const off = new URL(hunts.funnelLink({ ...cfg, funnels_live: false }, hunt, { niche: 'sound' }));
  check(off.pathname === '/create-a-space', `a hunt link with funnels_live false goes to ${off.pathname}`);
  check(off.searchParams.get('utm_source') === 'flowweb' && off.searchParams.get('niche') === 'sound', `a hunt link lost its tags: ${off}`);
  const on = new URL(hunts.funnelLink({ ...cfg, funnels_live: true }, hunt, { niche: 'sound' }));
  check(on.pathname === (cfg.dm_door?.path ?? cfg.funnels.host.path), `a hunt link with funnels_live true goes to ${on.pathname}`);

  const rh = await imp('packages/daemon/src/flows/reply-helper.ts');
  const tree = rh.loadTree(root, KEY);
  check(typeof tree.funnels_live === 'boolean', 'reply-tree.json has no funnels_live switch');
  const yes = rh.compose({ ...tree, funnels_live: false }, 'interested', 'teacher', 't9') ?? '';
  const replyLinks = (yes.match(/https?:\/\/[^\s<>"')\]]+/g) ?? []).map((l) => new URL(l.replace(/[.,]+$/, '')));
  check(replyLinks.length > 0, `the teacher yes has no link: ${yes}`);
  for (const u of replyLinks) {
    check(!/^\/(start\/host|for\/|launch)/.test(u.pathname), `a reply link is not live: ${u}`);
    check(u.searchParams.get('utm_content') === 'teacher.t9', `a reply link lost its tags: ${u}`);
  }

  // ---- 5. calendar fetches: no private address, a streamed byte cap -------------------------------------
  const intake = await imp('packages/daemon/src/flows/event-intake.ts');
  let fetched = 0;
  const get = async () => {
    fetched++;
    return new Response('BEGIN:VCALENDAR\nEND:VCALENDAR');
  };
  const refusedFor = async (url, lookup) => {
    try {
      await intake.fetchCalendar(url, now, get, lookup ? { lookup } : {});
      return null;
    } catch (e) {
      return e?.status ?? -1;
    }
  };
  for (const [url, addrs] of [
    ['http://169.254.169.254/latest/meta-data', null],
    ['http://10.0.0.5/cal.ics', null],
    ['http://192.168.1.10/cal.ics', null],
    ['http://[fd00::1]/cal.ics', null],
    ['http://[fe80::1]/cal.ics', null],
    ['https://cal.example/cal.ics', ['93.184.216.34', '172.16.0.9']],
  ])
    check((await refusedFor(url, addrs && (async () => addrs))) === 400, `fetchCalendar did not refuse ${url} (${addrs ?? 'literal'})`);
  check(fetched === 0, `a private address was fetched ${fetched} times`);
  let pulled = 0;
  const chunk = new TextEncoder().encode(`BEGIN:VCALENDAR\n${'X'.repeat(65_000)}\n`);
  const big = async () =>
    new Response(
      new ReadableStream({
        pull(c) {
          pulled += chunk.byteLength;
          if (pulled > 50_000_000) c.close();
          else c.enqueue(chunk);
        },
      }),
    );
  await intake.fetchCalendar('https://cal.example/big.ics', now, big, { lookup: async () => ['93.184.216.34'] }).catch(() => null);
  check(pulled < 3_000_000, `fetchCalendar read ${pulled} bytes of a body past its 2 MB cap`);

  // ---- 7. region names ---------------------------------------------------------------------------------
  const gate = await imp('packages/daemon/src/flows/draft-gate.ts');
  for (const region of ['Ontario', 'British Columbia', 'Scotland', 'Wales'])
    check(
      gate.checkDraft({ body: `Hi ${LINK}`, region, to: 'host@gmail.com' }).blocks.some((x) => x.code === 'restricted_region'),
      `the gate let a draft for ${region} through`,
    );
});
