// Probe for FW-C-034 (flow admin and uploads): `pnpm probe flows/flow-admin`. Tier 0.
// Surfaces: the daemon fwd (started as one node process on a fresh FW_HOME) and the admin routes
// under /v1/flows/neighborhood-activation, called with the CLI token fwd prints. Every write lands
// in $FW_HOME/flows/neighborhood-activation/ and shows up in the GET view.
//
// Proves, in order:
//   1. A write without a token answers 401, and nothing changes.
//   2. Uploading leads as CSV adds them; a row with an unknown kind or region is skipped with a
//      reason; uploading the same url again updates instead of duplicating.
//   3. Uploading metrics as CSV sets a region's measures, so its progress is a number, not unknown.
//   4. Marking a send on a lead records a touch with its route; an unknown lead answers 404.
//   5. Adding a lead to the do-not-contact list blocks it, and marking a send on it then answers 409.
//   6. Opening a region that borders no opened region answers 409; opening a bordering one adds it
//      to `opened`, and it becomes the active region.
//   7. Saving a config with a border that names no region answers 400 and changes nothing; saving a
//      valid config with a new hosts target changes the region's target.
//   8. Leads export as CSV with a header row and one line per lead.
//   9. Every accepted write is in the admin log the view returns, newest first.
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  check,
  DAEMON_BIN,
  freshHome,
  killAndWait,
  missing,
  probe,
  requireFile,
  root,
  spawnTs,
  waitFor,
} from '../c0/_lib.mjs';

const NAME = 'flows/flow-admin';
const BASE = '/v1/flows/neighborhood-activation';
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

function http(port, method, path, { token, body } = {}) {
  return new Promise((ok, bad) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) headers['content-type'] = 'application/json';
    const req = request({ host: '127.0.0.1', port, path, method, headers, timeout: 5000 }, (res) => {
      let text = '';
      res.on('data', (d) => {
        text += d;
      });
      res.on('end', () => ok({ status: res.statusCode, type: String(res.headers['content-type'] ?? ''), body: text }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', bad);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function startFwd(home) {
  const port = await freePort();
  const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(port)], { env: { FW_HOME: home } });
  kids.push(d);
  await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
  check(d.exitCode === null, `fwd did not start: ${d.output().trim().split('\n')[0]}`);
  const tokenPath = /CLI token file: (\S+)/.exec(d.output())?.[1];
  check(tokenPath, 'fwd did not print "CLI token file: <path>"');
  return { port, token: readFileSync(tokenPath, 'utf8').trim() };
}

await probe(NAME, async () => {
  requireFile('flows/neighborhood-activation/config.json', 'the neighborhood activation flow this probe administers');
  const cfg = JSON.parse(readFileSync(join(root, 'flows/neighborhood-activation/config.json'), 'utf8'));
  const seed = cfg.seed_territory_id;
  const byId = Object.fromEntries(cfg.territories.map((t) => [t.id, t]));
  const borders = (id) =>
    new Set([...byId[id].borders, ...cfg.territories.filter((t) => t.borders.includes(id)).map((t) => t.id)]);
  const near = [...borders(seed)][0];
  const far = cfg.territories.find((t) => t.id !== seed && !borders(seed).has(t.id))?.id;

  const home = freshHome('flow-admin');
  try {
    const f = await startFwd(home);
    const as = (method, path, body) => http(f.port, method, `${BASE}${path}`, { token: f.token, body });
    const view = async () => JSON.parse((await as('GET', '')).body).data;

    // ---- 1. no token ----------------------------------------------------------------------------
    const leadsCsv = [
      'name,kind,territory_id,sub_area,channel,source,url,fit,timing',
      `Ana Host,host,${seed},encinitas,movement,event_listings,https://example.com/ana,0.9,0.8`,
      `Cafe Uno,venue,${seed},carlsbad,,business_listings,https://example.com/cafe,0.8,0.2`,
      `Bad Kind,wizard,${seed},,,event_listings,https://example.com/bad,0.9,0.9`,
      `Nowhere,host,atlantis,,,event_listings,https://example.com/nowhere,0.9,0.9`,
    ].join('\n');
    let r = await http(f.port, 'POST', `${BASE}/leads`, { body: { format: 'csv', data: leadsCsv } });
    check(r.status === 401, `a write with no token answered ${r.status}, want 401`);

    // ---- 2. lead upload ---------------------------------------------------------------------------
    r = await as('POST', '/leads', { format: 'csv', data: leadsCsv });
    if (r.status === 404 || r.status === 405) missing(`POST ${BASE}/leads answered ${r.status} (no admin routes)`);
    check(r.status === 200, `lead upload answered ${r.status}: ${r.body.slice(0, 200)}`);
    let out = JSON.parse(r.body).data;
    check(out.added === 2, `lead upload added ${out.added}, want 2`);
    check(out.skipped?.length === 2 && out.skipped.every((s) => typeof s.reason === 'string' && s.reason), 'the two bad rows must be skipped, each with a reason');
    r = await as('POST', '/leads', {
      format: 'csv',
      data: `name,kind,territory_id,sub_area,channel,source,url,fit,timing\nAna Host,host,${seed},encinitas,movement,event_listings,https://example.com/ana,0.95,0.9`,
    });
    out = JSON.parse(r.body).data;
    check(out.added === 0 && out.updated === 1, `re-uploading a url gave added ${out.added}, updated ${out.updated}; want 0 and 1`);
    let v = await view();
    check(v.leads.length === 2, `the view has ${v.leads.length} leads, want 2`);
    const ana = v.leads.find((l) => l.url === 'https://example.com/ana');
    check(ana?.fit === 0.95, 'the re-upload did not update the lead');

    // ---- 3. metrics upload ------------------------------------------------------------------------
    r = await as('POST', '/metrics', {
      format: 'csv',
      data: `territory_id,hosts_active_28d,events_next_14d,sub_areas_covered_14d,wam\n${seed},34,41,5,260`,
    });
    check(r.status === 200, `metrics upload answered ${r.status}: ${r.body.slice(0, 200)}`);
    v = await view();
    const seedV = v.territories.find((t) => t.id === seed);
    check(seedV.measures?.hosts_active_28d === 34 && typeof seedV.progress === 'number', 'uploaded metrics did not reach the view');

    // ---- 4. mark a send ---------------------------------------------------------------------------
    r = await as('POST', `/leads/${encodeURIComponent(ana.id)}/touches`, { via: 'founder_email' });
    check(r.status === 200, `marking a send answered ${r.status}: ${r.body.slice(0, 200)}`);
    r = await as('POST', '/leads/no-such-lead/touches', { via: 'founder_email' });
    check(r.status === 404, `marking a send on an unknown lead answered ${r.status}, want 404`);
    v = await view();
    const anaAfter = v.leads.find((l) => l.id === ana.id);
    check(anaAfter.touches?.length === 1 && anaAfter.touches[0].via === 'founder_email', 'the send was not recorded with its route');

    // ---- 5. do-not-contact ------------------------------------------------------------------------
    const cafe = v.leads.find((l) => l.url === 'https://example.com/cafe');
    r = await as('POST', '/do-not-contact', { lead_id: cafe.id, reason: 'asked not to be contacted' });
    check(r.status === 200, `do-not-contact answered ${r.status}: ${r.body.slice(0, 200)}`);
    v = await view();
    check(v.leads.find((l) => l.id === cafe.id)?.stage === 'blocked', 'a do-not-contact lead is not blocked');
    r = await as('POST', `/leads/${encodeURIComponent(cafe.id)}/touches`, { via: 'founder_email' });
    check(r.status === 409, `marking a send on a do-not-contact lead answered ${r.status}, want 409`);

    // ---- 6. open a region -------------------------------------------------------------------------
    if (far) {
      r = await as('POST', '/open', { territory_id: far });
      check(r.status === 409, `opening a region that borders nothing open answered ${r.status}, want 409`);
    }
    r = await as('POST', '/open', { territory_id: near });
    check(r.status === 200, `opening a bordering region answered ${r.status}: ${r.body.slice(0, 200)}`);
    v = await view();
    check(v.opened.includes(near), 'the opened region is not in opened');
    check(v.territories.find((t) => t.id === near)?.status === 'active', 'the newly opened region is not active');

    // ---- 7. config edit ---------------------------------------------------------------------------
    const bad = structuredClone(cfg);
    bad.territories[0].borders = [...bad.territories[0].borders, 'atlantis'];
    r = await as('PUT', '/config', bad);
    check(r.status === 400, `saving a config with an unknown border answered ${r.status}, want 400`);
    const good = structuredClone(cfg);
    good.activation.hosts_floor = 120;
    r = await as('PUT', '/config', good);
    check(r.status === 200, `saving a valid config answered ${r.status}: ${r.body.slice(0, 200)}`);
    v = await view();
    check(v.territories.find((t) => t.id === seed)?.targets?.hosts_active_28d >= 120, 'the new hosts target did not reach the view');

    // ---- 8. export --------------------------------------------------------------------------------
    r = await as('GET', '/leads.csv');
    check(r.status === 200 && r.type.startsWith('text/csv'), `leads export answered ${r.status} ${r.type}, want 200 text/csv`);
    const lines = r.body.trim().split('\n');
    check(lines[0].includes('url') && lines.length === 1 + v.leads.length, 'the export needs a header row and one line per lead');

    // ---- 9. admin log -----------------------------------------------------------------------------
    check(Array.isArray(v.admin_log) && v.admin_log.length >= 7, `the admin log has ${v.admin_log?.length} entries, want at least 7`);
    check(v.admin_log[0].action === 'config', `the newest admin log entry is ${v.admin_log[0]?.action}, want config`);
  } finally {
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  }
});
