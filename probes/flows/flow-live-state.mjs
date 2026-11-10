// Probe for FW-C-064 (the Flows page shows a flow's real on/off state and its waiting drafts):
// `pnpm probe flows/flow-live-state`. Tier 0.
// Surfaces: the daemon fwd on a fresh FW_HOME, GET /v1/flows/neighborhood-activation and
// GET /v1/supervisor with the CLI token fwd prints, the Owner's switch
// POST /v1/supervisor/flows/{key}/enable|disable, and draft files in
// $FW_HOME/flows/neighborhood-activation/drafts/.
//
// Proves, in order:
//   1. A fresh fwd answers enabled false and awaiting_owner_total 0.
//   2. After the Owner turns the flow on, the flow view answers enabled true, as GET /v1/supervisor does.
//   3. awaiting_owner_total counts drafts waiting for the Owner and skips rejected and handed-off ones.
//   4. After the Owner turns the flow off, the flow view answers enabled false again.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { check, DAEMON_BIN, freshHome, killAndWait, probe, spawnTs, waitFor } from '../c0/_lib.mjs';

const NAME = 'flows/flow-live-state';
const KEY = 'neighborhood-activation';
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

function http(port, method, path, token) {
  return new Promise((ok, bad) => {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const req = request({ host: '127.0.0.1', port, path, method, headers, timeout: 10000 }, (res) => {
      let text = '';
      res.on('data', (d) => {
        text += d;
      });
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(text);
        } catch {}
        ok({ status: res.statusCode, body: text, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', bad);
    req.end();
  });
}

function writeDraft(home, id, status, lead) {
  const dir = join(home, 'flows', KEY, 'drafts');
  mkdirSync(dir, { recursive: true });
  const doc = { id, fire_id: 'fire_probe', lead_id: lead, channel: 'founder_email', subject: `Hello ${id}` };
  Object.assign(doc, { body: `Draft ${id} from the probe.`, status, created_at: '2026-11-10T12:00:00.000Z' });
  writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(doc, null, 2)}\n`);
}

await probe(NAME, async () => {
  const home = freshHome('flow-live-state');
  try {
    const port = await freePort();
    const d = spawnTs(DAEMON_BIN, ['--home', home, '--port', String(port)], { env: { FW_HOME: home } });
    kids.push(d);
    await waitFor(() => /listening on/.test(d.output()) || d.exitCode !== null, { timeoutMs: 30000, what: 'fwd to listen' });
    check(d.exitCode === null, `fwd did not start: ${d.output().trim().split('\n')[0]}`);
    const tokenPath = /CLI token file: (\S+)/.exec(d.output())?.[1];
    check(tokenPath, 'fwd did not print "CLI token file: <path>"');
    const token = readFileSync(tokenPath, 'utf8').trim();
    const view = async () => {
      const r = await http(port, 'GET', `/v1/flows/${KEY}`, token);
      check(r.status === 200, `GET /v1/flows/${KEY} answered ${r.status}: ${r.body.slice(0, 200)}`);
      return r.json.data;
    };
    const supOn = async () =>
      (await http(port, 'GET', '/v1/supervisor', token)).json?.data?.flows?.find((f) => f.key === KEY)?.enabled;

    // ---- 1. fresh: off, nothing waiting --------------------------------------------------------------
    const fresh = await view();
    check(fresh.enabled === false, `a fresh fwd answered enabled ${fresh.enabled}, want false`);
    check(fresh.awaiting_owner_total === 0, `a fresh fwd answered awaiting_owner_total ${fresh.awaiting_owner_total}, want 0`);

    // ---- 2. the Owner turns it on --------------------------------------------------------------------
    const on = await http(port, 'POST', `/v1/supervisor/flows/${KEY}/enable`, token);
    check(on.status === 200, `enabling ${KEY} answered ${on.status}: ${on.body.slice(0, 200)}`);
    check((await supOn()) === true, 'GET /v1/supervisor does not show the flow on after enable');
    const live = await view();
    check(live.enabled === true, `after enable GET /v1/flows/${KEY} answered enabled ${live.enabled}, want true (the Supervisor has it on)`);

    // ---- 3. waiting drafts are counted ---------------------------------------------------------------
    for (const [i, lead] of ['lead_a', 'lead_b', 'template:host'].entries()) writeDraft(home, `wait_${i}`, 'waiting_for_owner', lead);
    writeDraft(home, 'gone_1', 'rejected', 'lead_c');
    writeDraft(home, 'gone_2', 'handed_off', 'lead_d');
    const counted = await view();
    check(
      counted.awaiting_owner_total === 3,
      `with 3 drafts waiting (plus 1 rejected, 1 handed off) awaiting_owner_total is ${counted.awaiting_owner_total}, want 3`,
    );

    // ---- 4. the Owner turns it off -------------------------------------------------------------------
    const off = await http(port, 'POST', `/v1/supervisor/flows/${KEY}/disable`, token);
    check(off.status === 200, `disabling ${KEY} answered ${off.status}: ${off.body.slice(0, 200)}`);
    const offView = await view();
    check(offView.enabled === false, `after disable GET /v1/flows/${KEY} answered enabled ${offView.enabled}, want false`);
    check(offView.awaiting_owner_total === 3, 'turning the flow off changed the waiting count');
  } finally {
    for (const k of kids) if (k.exitCode === null) await killAndWait(k, 'SIGKILL');
  }
});
