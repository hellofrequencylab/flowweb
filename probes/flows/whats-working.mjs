// Probe for FW-C-072 (the Owner sees what's working from the flow's weekly review):
// `pnpm probe flows/whats-working`.
// probe-timeout-s: 240
// Tier 0.
// Surfaces: the daemon fwd on a fresh FW_HOME, the hunt and review routes under
// /v1/flows/neighborhood-activation with the CLI token fwd prints, the flow's files under
// $FW_HOME/flows/neighborhood-activation/ (drafts/, outcomes.json), hosted/relay/fw-relay.mjs, and the
// WhatsWorking component exported from packages/web/src/flows. The component checks are in
// probes/flows/whats-working.spec.tsx, run with vitest in jsdom against a fetch stub standing in for fwd.
//
// The surface this probe expects:
//   GET /v1/flows/{key}/review/summary -> 200 { data: summary }; 404 for a flow that does not exist.
//   summary = { flow, state: 'none' | 'thin' | 'ready', at: string | null, week: 'YYYY-Www' | null,
//               min_sent: 8, sample_ok: boolean,
//               totals: { sent, replied, signups, reply_rate, signup_rate },
//               dimensions: [{ key: 'source' | 'hunt' | 'funnel' | 'sub_area' | 'angle', label, tracked,
//                              judged, best: item | null, worst: item | null }],
//               learnings: [string] }
//   item = { value, name, sent, replied, signups, reply_rate, signup_rate }
//   A draft counts as sent when it has sent_at, replied when it has replied_at, signed up when its tag has
//   a member or host in outcomes.json. Only values with min_sent or more sent are judged; best is the
//   judged value with the highest reply rate, worst the lowest when two or more are judged. Source is the
//   draft's source, or the host of its source_url without www.; sub-area the draft's sub_area; angle the
//   draft's angle; hunt the hunt's name. A dimension no sent draft carries is tracked: false.
//   The relay snapshot copies /flows/{key}/review/summary for each flow.
//
// Proves, in order:
//   1. Before any review the summary answers state none; an unknown flow answers 404.
//   2. With 3 sent drafts the review's summary answers state thin, sample_ok false and no best hunt.
//   3. With hunt A 12 sent (6 replied, 2 signed up) and hunt B 19 sent (1 replied), the summary answers
//      ready with the review's at and week, totals 31 sent 7 replied, best and worst hunt, best source and
//      best angle, and learnings naming A.
//   4. The hosted relay copies the summary.
//   5. The component checks pass (4 of them).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { check, DAEMON_BIN, freshHome, killAndWait, missing, probe, root, spawnTs, tmpDir, waitFor } from '../c0/_lib.mjs';

const NAME = 'flows/whats-working';
const KEY = 'neighborhood-activation';
const BASE = `/v1/flows/${KEY}`;
const kids = [];

function freePort() {
  return new Promise((ok) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

function http(port, method, path, token, body) {
  return new Promise((ok, bad) => {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const payload = body === undefined ? null : JSON.stringify(body);
    if (payload !== null) headers['content-type'] = 'application/json';
    const req = request({ host: '127.0.0.1', port, path, method, headers, timeout: 10000 }, (res) => {
      let text = '';
      res.on('data', (d) => {
        text += d;
      });
      res.on('end', () => ok({ status: res.statusCode, body: text }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', bad);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

const json = (r) => {
  try {
    return JSON.parse(r.body);
  } catch {
    return undefined;
  }
};

async function startFwd(home) {
  const port = await freePort();
  const env = { FW_HOME: home, FW_VENDOR: 'fake', FW_OUTCOMES_PULL_EVERY_MS: '86400000', FW_REVIEW_EVERY_MS: '604800000' };
  const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(port)], { env });
  kids.push(d);
  await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
  check(d.exitCode === null, `fwd did not start: ${d.output().trim().split('\n')[0]}`);
  const tokenPath = /CLI token file: (\S+)/.exec(d.output())?.[1];
  check(tokenPath, 'fwd did not print "CLI token file: <path>"');
  return { d, port, token: readFileSync(tokenPath, 'utf8').trim() };
}

/** Writes n sent drafts for a hunt; the first `replied` have replied_at. Answers their tags. */
function seedDrafts(dir, huntId, n, replied, extra) {
  mkdirSync(dir, { recursive: true });
  const tags = [];
  for (let i = 0; i < n; i++) {
    const id = `${huntId}-${String(i).padStart(12, '0')}`;
    tags.push(id);
    const doc = {
      flow: KEY,
      id,
      hunt_id: huntId,
      tag: id,
      channel: 'frequency',
      send_via: 'email',
      build: false,
      to: `organizer${i}@${huntId}.example.com`,
      subject: 'Hello',
      body: 'Hi',
      status: 'waiting_for_owner',
      created_at: '2026-11-01T00:00:00.000Z',
      sent_at: '2026-11-02T00:00:00.000Z',
      ...(i < replied ? { replied_at: '2026-11-03T00:00:00.000Z' } : {}),
      ...extra,
    };
    writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(doc, null, 2)}\n`);
  }
  return tags;
}

await probe(NAME, async () => {
  const home = freshHome('whats-working');
  try {
    const flowDir = join(home, 'flows', KEY);
    const drafts = join(flowDir, 'drafts');
    const f = await startFwd(home);
    const api = (method, path, body) => http(f.port, method, path, f.token, body);
    check((await api('POST', `/v1/supervisor/flows/${KEY}/enable`)).status === 200, `enabling ${KEY} failed`);

    // ---- 1. no review yet ---------------------------------------------------------------------------
    const first = await api('GET', `${BASE}/review/summary`);
    if (first.status === 404 || first.status === 405) missing(`GET ${BASE}/review/summary answered ${first.status} (no summary route)`);
    check(first.status === 200, `the summary answered ${first.status}: ${first.body.slice(0, 200)}`);
    const none = json(first)?.data;
    check(none?.state === 'none' && none?.at === null, `before any review the summary is ${JSON.stringify(none)}`);
    const unknown = await api('GET', '/v1/flows/no-such-flow/review/summary');
    check(unknown.status === 404, `an unknown flow's summary answered ${unknown.status}, want 404`);

    const mk = async (name) => {
      const r = await api('POST', `${BASE}/hunts`, { name, looking_for: name, region: 'north-county-sd', max_sends: 10 });
      check(r.status === 201, `saving hunt ${name} answered ${r.status}: ${r.body.slice(0, 200)}`);
      return json(r).data;
    };
    const A = await mk('Sound baths');
    const B = await mk('Chess clubs');

    // ---- 2. too few sent ------------------------------------------------------------------------------
    seedDrafts(drafts, `${B.id}x`, 3, 1, { hunt_id: B.id, source_url: 'https://www.meetup.com/chess/', angle: 'community' });
    check((await api('POST', `${BASE}/review/run`)).status === 200, 'running the first review failed');
    const thin = json(await api('GET', `${BASE}/review/summary`))?.data;
    const dim = (s, k) => s?.dimensions?.find((d) => d.key === k);
    check(thin?.state === 'thin' && thin?.sample_ok === false, `with 3 sent the summary is ${thin?.state}, sample_ok ${thin?.sample_ok}`);
    check(thin?.min_sent === 8, `min_sent is ${thin?.min_sent}, want 8`);
    check(dim(thin, 'hunt')?.best == null, `with 3 sent a best hunt was named: ${JSON.stringify(dim(thin, 'hunt'))}`);
    check(thin?.totals?.sent === 3 && thin?.totals?.replied === 1, `thin totals: ${JSON.stringify(thin?.totals)}`);

    // ---- 3. enough sent -------------------------------------------------------------------------------
    const tagsA = seedDrafts(drafts, A.id, 12, 6, { source_url: 'https://www.eventbrite.com/e/1', angle: 'their-event', sub_area: 'leucadia' });
    seedDrafts(drafts, B.id, 16, 0, { source_url: 'https://www.meetup.com/chess/', angle: 'community', sub_area: 'carlsbad-village' });
    writeFileSync(
      join(flowDir, 'outcomes.json'),
      JSON.stringify({
        pulled_at: '2026-11-09T00:00:00.000Z',
        outcomes: [
          { campaign: A.id, content: tagsA[0], medium: 'email', src: 'hunt', leads: 1, members: 1, hosts: 1, paid: 0 },
          { campaign: A.id, content: tagsA[7], medium: 'email', src: 'hunt', leads: 1, members: 1, hosts: 0, paid: 0 },
        ],
        regions: [],
      }),
    );
    const run = await api('POST', `${BASE}/review/run`);
    check(run.status === 200, `running the review answered ${run.status}: ${run.body.slice(0, 200)}`);
    const rev = json(run).data;
    const s = json(await api('GET', `${BASE}/review/summary`))?.data;
    check(s?.state === 'ready' && s?.sample_ok === true, `with enough sent the summary is ${s?.state}, sample_ok ${s?.sample_ok}`);
    check(s?.at === rev.at, `the summary's at ${s?.at} is not the review's ${rev.at}`);
    check(/^\d{4}-W\d{2}$/.test(s?.week ?? ''), `week is ${s?.week}, want YYYY-Www`);
    const t = s?.totals;
    check(t?.sent === 31 && t?.replied === 7 && t?.signups === 2, `totals: ${JSON.stringify(t)}`);
    check(Math.abs((t?.reply_rate ?? -1) - 7 / 31) < 0.001, `reply_rate ${t?.reply_rate}, want ${7 / 31}`);
    check(Math.abs((t?.signup_rate ?? -1) - 2 / 31) < 0.001, `signup_rate ${t?.signup_rate}, want ${2 / 31}`);
    const keys = (s?.dimensions ?? []).map((d) => d.key).join(',');
    check(keys === 'source,hunt,funnel,sub_area,angle', `dimensions are ${keys}`);
    const hunt = dim(s, 'hunt');
    check(
      hunt?.best?.name === A.name && hunt.best.sent === 12 && hunt.best.replied === 6 && hunt.best.signups === 2,
      `best hunt: ${JSON.stringify(hunt?.best)}`,
    );
    check(hunt?.worst?.name === B.name && hunt.worst.replied === 1 && hunt.worst.sent === 19, `worst hunt: ${JSON.stringify(hunt?.worst)}`);
    check(dim(s, 'source')?.best?.name === 'eventbrite.com', `best source: ${JSON.stringify(dim(s, 'source')?.best)}`);
    check(dim(s, 'source')?.worst?.name === 'meetup.com', `worst source: ${JSON.stringify(dim(s, 'source')?.worst)}`);
    check(dim(s, 'angle')?.best?.name === 'their-event', `best angle: ${JSON.stringify(dim(s, 'angle')?.best)}`);
    check(dim(s, 'sub_area')?.best?.name === 'leucadia', `best sub-area: ${JSON.stringify(dim(s, 'sub_area')?.best)}`);
    check(dim(s, 'funnel')?.tracked === true, `funnel is not tracked: ${JSON.stringify(dim(s, 'funnel'))}`);
    check(Array.isArray(s?.learnings) && s.learnings.some((l) => l.includes(A.name)), `learnings do not name ${A.name}: ${JSON.stringify(s?.learnings)}`);
  } finally {
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  }

  // ---- 4. the relay copies it -------------------------------------------------------------------------
  const relay = readFileSync(join(root, 'hosted/relay/fw-relay.mjs'), 'utf8');
  check(/\/review\/summary/.test(relay), 'the hosted relay does not copy /flows/{key}/review/summary');

  // ---- 5. the component -------------------------------------------------------------------------------
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('whats-working'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/flows/whats-working.spec.tsx')], testTimeout: 30000 },
    }).replace(/}$/, '')}, resolve: { alias: [
      { find: /^react(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react`)} + '$1' },
      { find: /^react-dom(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react-dom`)} + '$1' },
      { find: '@testing-library/react', replacement: ${JSON.stringify(`${mods}/@testing-library/react`)} },
    ] } };\n`,
  );
  const r = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--config', cfg], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (/does not provide an export named 'WhatsWorking'|WhatsWorking is not/.test(out))
    missing('packages/web/src/flows does not export WhatsWorking (row FW-C-072)');
  const failed = out.split('\n').filter((l) => /✗|×|FAIL|AssertionError|Error:/.test(l)).slice(0, 8);
  check(r.status === 0, `the what's working checks failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+4 passed/.test(out), `expected 4 what's working checks to pass:\n${out.slice(-400)}`);
});
