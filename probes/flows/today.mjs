// Probe for FW-C-105 (the Today list: one ranked list of actions a day): `pnpm probe flows/today`.
// probe-timeout-s: 240
// Tier 0.
// Surfaces: a real fwd on a fresh FW_HOME (FW_VENDOR=fake) with the CLI token, draft files written into
// $FW_HOME/flows/neighborhood-activation/drafts/, the optional $FW_HOME/flows/<flow>/leads.json, the web
// Today panel (its checks are in probes/flows/today.spec.tsx, run with vitest in jsdom against a fetch stub,
// as probes/flows/drafts-inbox.mjs does), and packages/web/src/flows/ActivationPage.tsx.
//
// The surface this probe expects:
//   GET /v1/flows/{key}/today[?size=N]  (CLI token or paired session; 401 without, 404 for an unknown flow)
//     -> 200 { data: { flow, size, ranked_by: 'score' | 'age', actions: [...], skips: { <reason>: n } } }
//     size is 15 by default and at most 25; actions never number more than size.
//     Each action: { id, kind, draft_id, lead_id, name, route, open_url, body, words, score, created_at, ... }
//       kind is cold, sequence, warm, venue, approve_lead or show_up. A draft action carries draft_id, its
//       body and words (its word count). route is email, dm, form or platform; an email action opens
//       mailto:<to>..., a dm action opens the draft's contact_url.
//     Only drafts waiting for the Owner, never sent and at most 3 days old become actions.
//     Without leads.json: ranked_by age, oldest draft first. With leads.json ({ nodes: [{ id, state,
//     score: { value }, kind, warm, name }] }, a draft's lead_id naming a node): ranked_by score, highest
//     first; a node with state proposed is an approve_lead action carrying its lead_id.
//   POST /v1/supervisor/flows/{key}/drafts/{id}/reject { reason } with reason one of wrong_niche, not_local,
//     not_a_fit, on_frequency rejects the draft and counts the reason in today's skips; any other reason
//     answers 400 and rejects nothing.
//   ActivationPage renders <Today above <DraftsInbox.
//
// Proves, in order:
//   1. The Flows page renders Today above the drafts inbox.
//   2. Without leads.json: 15 actions by default, ranked oldest first; old, rejected, handed off and sent
//      drafts are absent; email and dm actions carry the right open link and word count.
//   3. ?size=25 answers every eligible draft (20) and ?size=99 never more than 25.
//   4. With leads.json: ranked by score, highest first, still 15; the proposed lead is a one-tap approval;
//      the old draft stays absent even with the best score.
//   5. A skip with a reason rejects the draft and is counted; a bad reason answers 400; no token answers
//      401 and an unknown flow 404.
//   6. The Today panel checks pass (5 of them).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, freshHome, missing, probe, root, tmpDir } from '../c0/_lib.mjs';
import { api, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/today';
const KEY = 'neighborhood-activation';
const T = `/v1/flows/${KEY}/today`;
const SUP = `/v1/supervisor/flows/${KEY}`;
const HOUR = 3600e3;

const pad = (n) => String(n).padStart(2, '0');
const words = (s) => s.trim().split(/\s+/).filter(Boolean).length;

await probe(NAME, async () => {
  // 1. The Flows page renders Today above the drafts inbox.
  const page = readFileSync(join(root, 'packages/web/src/flows/ActivationPage.tsx'), 'utf8');
  const at = page.search(/<Today\b/);
  if (at < 0) missing('the Flows page does not render <Today> (row FW-C-105)');
  check(at < page.search(/<DraftsInbox\b/), 'the Flows page renders <Today> below the drafts inbox, want above');

  // Drafts: 20 waiting (3 to 60 hours old), one waiting but 4 days old, one rejected, one handed off and
  // one the Owner already sent by hand. Odd ones go by email, even ones by Instagram DM.
  const home = realpathSync(freshHome('today'));
  const dir = join(home, 'flows', KEY, 'drafts');
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const bodies = {};
  const write = (id, hoursAgo, over = {}) => {
    const n = Number(id.slice(1)) || 0;
    const email = n % 2 === 1;
    const body = `Hi ${id} host, I'm Daniel, founder of Frequency. Would a free page for your circle help? ${'word '.repeat(n)}`.trim();
    bodies[id] = body;
    const doc = {
      flow: KEY,
      id,
      fire_id: 'fire_probe',
      lead_id: `lead:${id}`,
      channel: 'frequency',
      name: `Host ${id}`,
      subject: `Hello from Daniel ${id}`,
      body,
      status: 'waiting_for_owner',
      created_at: new Date(now - hoursAgo * HOUR).toISOString(),
      source_url: `https://example.org/source/${id}`,
      niche: 'sound bath',
      region: 'Encinitas',
      send_via: email ? 'email' : 'social',
      ...(email ? { to: `${id}@example.org` } : { contact_url: `https://www.instagram.com/${id}_host` }),
      ...over,
    };
    writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(doc, null, 2)}\n`);
  };
  const ids = [];
  for (let i = 1; i <= 20; i++) {
    const id = `d${pad(i)}`;
    ids.push(id);
    write(id, i * 3);
  }
  write('d90', 96);
  write('d91', 5, { status: 'rejected', rejected_at: new Date(now - 4 * HOUR).toISOString() });
  write('d92', 5, { status: 'handed_off', approved_at: new Date(now - 4 * HOUR).toISOString() });
  write('d93', 5, { sent_at: new Date(now - 4 * HOUR).toISOString() });
  const never = ['d90', 'd91', 'd92', 'd93'];

  const fwd = await startFwd(home, { env: { FW_VENDOR: 'fake' } });
  try {
    const get = async (path) => {
      const r = await api(fwd.port, 'GET', path, { auth: fwd.token });
      if (r.status === 404 && path.startsWith(T)) missing(`GET ${path} answered 404 (no Today route)`);
      check(r.status === 200, `GET ${path} answered ${r.status}: ${r.text.slice(0, 200)}`);
      return r.json?.data ?? {};
    };
    const draftIds = (d) => (d.actions ?? []).filter((a) => a.draft_id).map((a) => a.draft_id);

    // 2. Without leads.json: ranked by age.
    const a = await get(T);
    check(Array.isArray(a.actions), `Today answered no actions array: ${JSON.stringify(a).slice(0, 200)}`);
    check(a.size === 15, `the default size is ${a.size}, want 15`);
    check(a.actions.length === 15, `Today answered ${a.actions.length} actions, want 15`);
    check(a.ranked_by === 'age', `without leads.json ranked_by is ${a.ranked_by}, want age`);
    const byAge = ids.slice().reverse().slice(0, 15);
    check(
      JSON.stringify(draftIds(a)) === JSON.stringify(byAge),
      `without leads.json the order is ${draftIds(a).join(' ')}, want oldest first ${byAge.join(' ')}`,
    );
    for (const id of never) check(!draftIds(a).includes(id), `${id} should never be on Today`);
    const em = a.actions.find((x) => x.draft_id === 'd19');
    const dm = a.actions.find((x) => x.draft_id === 'd20');
    check(em?.route === 'email', `d19 route is ${em?.route}, want email`);
    check(String(em?.open_url ?? '').startsWith('mailto:d19@example.org'), `d19 opens ${em?.open_url}, want mailto:d19@example.org`);
    check(dm?.route === 'dm', `d20 route is ${dm?.route}, want dm`);
    check(dm?.open_url === 'https://www.instagram.com/d20_host', `d20 opens ${dm?.open_url}, want its profile`);
    check(em?.body === bodies.d19, 'the d19 action does not carry its draft text');
    check(em?.words === words(bodies.d19), `d19 words is ${em?.words}, want ${words(bodies.d19)}`);
    check(em?.name === 'Host d19', `d19 name is ${em?.name}, want Host d19`);

    // 3. The size.
    const big = await get(`${T}?size=25`);
    check(big.actions.length === 20, `?size=25 answered ${big.actions.length} actions, want all 20 eligible`);
    const huge = await get(`${T}?size=99`);
    check(huge.actions.length <= 25 && huge.size <= 25, `?size=99 answered size ${huge.size} with ${huge.actions.length}`);

    // 4. With leads.json: ranked by score. The newest draft has the best score; the 4-day-old one better still.
    const nodes = ids.map((id) => ({ id: `lead:${id}`, state: 'approved', kind: 'host', warm: false, name: `Host ${id}`, score: { value: (21 - Number(id.slice(1))) / 100 } }));
    nodes.push({ id: 'lead:d90', state: 'approved', kind: 'host', warm: false, name: 'Host d90', score: { value: 0.99 } });
    nodes.push({ id: 'lead:p1', state: 'proposed', kind: 'venue', warm: false, name: 'Proposed Studio', niche: 'yoga', town: 'Leucadia', source_url: 'https://example.org/studio', score: { value: 0.155 } });
    writeFileSync(join(home, 'flows', KEY, 'leads.json'), `${JSON.stringify({ nodes }, null, 2)}\n`);
    const s = await get(T);
    check(s.ranked_by === 'score', `with leads.json ranked_by is ${s.ranked_by}, want score`);
    check(s.actions.length === 15, `with leads.json Today answered ${s.actions.length} actions, want 15`);
    const scores = s.actions.map((x) => x.score);
    check(
      scores.every((v, i) => typeof v === 'number' && (i === 0 || v <= scores[i - 1])),
      `with leads.json the scores are not highest first: ${scores.join(' ')}`,
    );
    const want = ['d01', 'd02', 'd03', 'd04', 'd05'];
    check(JSON.stringify(draftIds(s).slice(0, 5)) === JSON.stringify(want), `with leads.json the first drafts are ${draftIds(s).slice(0, 5).join(' ')}, want ${want.join(' ')}`);
    const prop = s.actions.find((x) => x.kind === 'approve_lead');
    check(prop?.lead_id === 'lead:p1' && !prop.draft_id, `the proposed lead is not a one-tap approval: ${JSON.stringify(prop)}`);
    check(!draftIds(s).includes('d90'), 'the 4-day-old draft is on Today with leads.json');

    // 5. Skip with a reason, a bad reason, no token, an unknown flow.
    const skip = await api(fwd.port, 'POST', `${SUP}/drafts/d01/reject`, { auth: fwd.token, body: { reason: 'not_local' } });
    check(skip.status === 200, `a skip answered ${skip.status}: ${skip.text.slice(0, 200)}`);
    const bad = await api(fwd.port, 'POST', `${SUP}/drafts/d02/reject`, { auth: fwd.token, body: { reason: 'meh' } });
    check(bad.status === 400, `a skip with an unknown reason answered ${bad.status}, want 400`);
    const d02 = JSON.parse(readFileSync(join(dir, 'd02.json'), 'utf8'));
    check(d02.status === 'waiting_for_owner', `a refused skip changed d02 to ${d02.status}`);
    const after = await get(T);
    check(!draftIds(after).includes('d01'), 'the skipped draft is still on Today');
    check(draftIds(after).includes('d02'), 'the draft with a refused skip left Today');
    check(after.skips?.not_local === 1, `today's skips are ${JSON.stringify(after.skips)}, want not_local 1`);
    const anon = await api(fwd.port, 'GET', T);
    check(anon.status === 401, `Today without a token answered ${anon.status}, want 401`);
    const none = await api(fwd.port, 'GET', '/v1/flows/no-such-flow/today', { auth: fwd.token });
    check(none.status === 404, `Today for an unknown flow answered ${none.status}, want 404`);
  } finally {
    await fwd.stop();
  }

  // 6. The Today panel.
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(realpathSync(tmpDir('today')), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/flows/today.spec.tsx')], testTimeout: 30000 },
    }).replace(/}$/, '')}, resolve: { alias: [
      { find: /^react(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react`)} + '$1' },
      { find: /^react-dom(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react-dom`)} + '$1' },
      { find: '@testing-library/react', replacement: ${JSON.stringify(`${mods}/@testing-library/react`)} },
    ] } };\n`,
  );
  if (!existsSync(join(root, 'packages/web/src/flows/Today.tsx')))
    missing('packages/web/src/flows/Today.tsx does not exist (row FW-C-105)');
  const r = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--config', cfg], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (/does not provide an export named 'Today'|Today is not/.test(out))
    missing('packages/web/src/flows does not export Today (row FW-C-105)');
  const failed = out.split('\n').filter((l) => /✗|×|FAIL|AssertionError|Error:/.test(l)).slice(0, 8);
  check(r.status === 0, `the Today panel checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+5 passed/.test(out), `expected 5 Today panel checks to pass:\n${out.slice(-400)}`);
});
