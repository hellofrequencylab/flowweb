// Probe for FW-C-071 (Copilot and Autopilot only with a sender on the Owner's Mac): `pnpm probe flows/sender-honest`.
// probe-timeout-s: 240
// Tier 0.
// Surfaces: senders/email.mjs run once on a fresh FW_HOME with an empty outbox (it sends nothing and asks
// no Keychain), a real fwd on a fresh FW_HOME with its CLI token, hosted/server/requests.mjs (pure: the
// relay asks it before applying a site request on the Owner's Mac), and packages/web's FlowControls and
// DraftsInbox (their checks are in probes/flows/sender-honest.spec.tsx, run with vitest in jsdom against a
// fetch stub, as probes/flows/drafts-inbox.mjs does).
//
// The surface this probe expects:
//   `node senders/email.mjs --once` with readable settings ends every pass by writing
//     $FW_HOME/senders/email/last-pass.json { at: ISO time, ok, sent }; without settings it exits non-zero
//     and writes none.
//   GET /v1/status data.sender and GET /v1/supervisor data.sender are { installed, last_pass_at }:
//     installed is true only when last-pass.json's at is within the last 24 hours; last_pass_at is that
//     time (also when it is older), or null with no heartbeat.
//   senderHold(request, sender) from hosted/server/requests.mjs: for a flow.dial request to copilot or
//     autopilot and a sender that is not installed (or unknown), a reason that names the sender; otherwise
//     null. The relay refuses such a site request with that reason instead of calling fwd.
//
// Proves, in order:
//   1. A sender pass with no settings writes no heartbeat; one with settings writes a fresh one.
//   2. fwd reports no heartbeat as not installed, a heartbeat 25 hours old with its time but not installed,
//      and the sender's own fresh heartbeat as installed, on both routes.
//   3. senderHold holds a site move to Copilot or Autopilot without an installed sender, and nothing else.
//   4. The Flows page checks pass (4 of them): Copilot and Autopilot disabled with "Needs a sender on your
//      Mac" and a link to the sender steps when there is none, enabled when there is one; a ready draft
//      shows Copy and send (copies, approves nothing) without a sender, and Approve with one.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { baseEnv, check, freshHome, missing, probe, root, tmpDir } from '../c0/_lib.mjs';
import { api, startFwd } from '../lib/fwd.mjs';

const NAME = 'flows/sender-honest';
const KEY = 'neighborhood-activation';
const SENDER = 'senders/email.mjs';
const beatOf = (home) => join(home, 'senders', 'email', 'last-pass.json');

function senderPass(home) {
  return spawnSync(process.execPath, [join(root, SENDER), '--once'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    env: baseEnv({ FW_HOME: home, HOME: home }),
  });
}

function settings(home) {
  mkdirSync(join(home, 'senders'), { recursive: true });
  writeFileSync(
    join(home, 'senders', 'email.json'),
    JSON.stringify({
      mailboxes: { personal: { address: 'probe@example.org', name: 'Probe Owner' } },
      routes: { founder_email: 'personal' },
      postal: '1 Probe Street, Nowhere, CA 00000',
    }),
  );
}

await probe(NAME, async () => {
  // 1. The sender's heartbeat.
  if (!existsSync(join(root, SENDER))) missing(`${SENDER} does not exist (row FW-C-042)`);
  const bare = freshHome('sender-honest-bare');
  const none = senderPass(bare);
  check(none.status !== 0, `a sender pass with no settings exited ${none.status}, want non-zero`);
  check(!existsSync(beatOf(bare)), 'a sender pass with no settings wrote a heartbeat');
  const home = freshHome('sender-honest');
  settings(home);
  const before = Date.now();
  const once = senderPass(home);
  check(once.status === 0, `a sender pass with settings and an empty outbox exited ${once.status}: ${(once.stderr ?? '').slice(0, 300)}`);
  if (!existsSync(beatOf(home))) missing(`a sender pass wrote no ${beatOf(home)} (row FW-C-071)`);
  const beat = JSON.parse(readFileSync(beatOf(home), 'utf8'));
  const at = Date.parse(beat?.at);
  check(Number.isFinite(at) && at >= before - 2000 && at <= Date.now() + 2000, `the heartbeat's at is ${beat?.at}, want the time of the pass`);
  const fresh = beat.at;

  // 2. fwd on a home with no heartbeat, then a stale one, then the sender's fresh one.
  const fwHome = freshHome('sender-honest-fwd');
  const fwd = await startFwd(fwHome, { env: { FW_VENDOR: 'fake' } });
  try {
    const expectSender = async (installed, last, what) => {
      for (const path of ['/v1/status', '/v1/supervisor']) {
        const r = await api(fwd.port, 'GET', path, { auth: fwd.token });
        check(r.status === 200, `GET ${path} answered ${r.status}`);
        const s = r.json?.data?.sender;
        if (s === undefined) missing(`GET ${path} has no sender (row FW-C-071)`);
        check(s?.installed === installed, `${what}: GET ${path} sender.installed is ${s?.installed}, want ${installed}`);
        check(s?.last_pass_at === last, `${what}: GET ${path} sender.last_pass_at is ${s?.last_pass_at}, want ${last}`);
      }
    };
    await expectSender(false, null, 'with no heartbeat');
    const old = new Date(Date.now() - 25 * 3600e3).toISOString();
    mkdirSync(join(fwHome, 'senders', 'email'), { recursive: true });
    writeFileSync(beatOf(fwHome), JSON.stringify({ at: old, ok: true, sent: 0 }));
    await expectSender(false, old, 'with a heartbeat 25 hours old');
    writeFileSync(beatOf(fwHome), JSON.stringify(beat));
    await expectSender(true, fresh, 'with a fresh heartbeat');
  } finally {
    await fwd.stop();
  }

  // 3. The relay holds a site move to Copilot or Autopilot without a sender.
  const { senderHold } = await import(pathToFileURL(join(root, 'hosted/server/requests.mjs')).href);
  if (typeof senderHold !== 'function') missing('hosted/server/requests.mjs does not export senderHold (row FW-C-071)');
  const dial = (stop) => ({ kind: 'flow.dial', flow: KEY, draft_id: null, payload: { stop } });
  const off = { installed: false, last_pass_at: null };
  const on = { installed: true, last_pass_at: fresh };
  for (const stop of ['copilot', 'autopilot']) {
    for (const s of [off, undefined, null]) {
      const why = senderHold(dial(stop), s);
      check(typeof why === 'string' && /sender/i.test(why), `${stop} with sender ${JSON.stringify(s)} was not held: ${why}`);
    }
    check(senderHold(dial(stop), on) === null, `${stop} with an installed sender was held`);
  }
  check(senderHold(dial('draft'), off) === null, 'a move to Draft without a sender was held');
  check(senderHold({ kind: 'flow.enable', flow: KEY, draft_id: null, payload: {} }, off) === null, 'turning a flow on without a sender was held');

  // 4. The Flows page.
  const mods = join(root, 'packages/web/node_modules');
  const cfg = join(tmpDir('sender-honest'), 'vitest.config.mjs');
  writeFileSync(
    cfg,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/flows/sender-honest.spec.tsx')], testTimeout: 30000 },
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
  const failed = out.split('\n').filter((l) => /✗|×|FAIL|AssertionError|Error:/.test(l)).slice(0, 8);
  check(r.status === 0, `the sender checks on the Flows page failed (exit ${r.status}):\n${failed.join('\n') || out.slice(-800)}`);
  check(/Tests\s+4 passed/.test(out), `expected 4 sender checks on the Flows page to pass:\n${out.slice(-400)}`);
});
