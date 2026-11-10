// Probe for FW-C-094 (whether email sending, the Frequency link and Google Analytics are set up, from Settings,
// not only by reading senders/README.md on the Mac): `pnpm probe settings/connections`.
// probe-timeout-s: 240
// Tier 0.
// Surfaces: a real fwd on a fresh FW_HOME with FW_KEYCHAIN=off (so the machine's own keychain never decides
// the answer), hosted/relay/fw-relay.mjs, and the Settings section
// packages/web/src/settings/ConnectionsSettings.tsx (its checks are in probes/settings/connections.spec.tsx,
// vitest in jsdom against a fetch stub).
//
// The surface this probe expects:
//   GET /v1/connections -> { email, frequency, ga4 }, each with ready (boolean) and fix (string[]).
//     email: settings, mailboxes [{ address, password }], postal, claim_url, claim_secret, last_pass_at, running.
//     frequency: site (FW_FREQUENCY_URL or null), outcomes_secret.
//     ga4: property_id, credential, key, last_pull (from the paid-ads flow's config).
//   A secret is checked for presence only; its value never appears in the answer.
//
// Proves, in order:
//   1. With nothing set, every connection reads not ready and its fix names what is missing.
//   2. With the secrets, the sender's settings and a fresh sender pass in FW_HOME, each reads what is set,
//      and neither secret value appears. A paired browser may read it; no session may not.
//   3. The relay mirrors /connections.
//   4. The Settings checks pass (3 of them).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, freshHome, missing, probe, root, tmpDir } from '../c0/_lib.mjs';
import { api, pair, startFwd } from '../lib/fwd.mjs';

const NAME = 'settings/connections';
const SECRET_OUTCOMES = 'probe-outcomes-value-7f3a9c';
const SECRET_GA4 = 'probe-ga4-value-2b8e41';
const SITE = 'https://frequency.example';
const ADDRESS = 'owner@example.com';

await probe(NAME, async () => {
  if (!existsSync(join(root, 'packages/web/src/settings/ConnectionsSettings.tsx')))
    missing('packages/web/src/settings/ConnectionsSettings.tsx does not exist (row FW-C-094)');

  const home = freshHome('connections');
  const fwd = await startFwd(home, { env: { FW_VENDOR: 'fake', FW_KEYCHAIN: 'off', FW_FREQUENCY_URL: SITE } });
  try {
    const read = async (auth = fwd.token) => api(fwd.port, 'GET', '/v1/connections', { auth });

    // 1. Nothing set.
    const first = await read();
    check(first.status === 200, `GET /v1/connections answered ${first.status}: ${first.text.slice(0, 200)}`);
    const a = first.json?.data ?? {};
    for (const k of ['email', 'frequency', 'ga4'])
      check(a[k] && typeof a[k].ready === 'boolean' && Array.isArray(a[k].fix), `${k} has no ready and fix: ${JSON.stringify(a[k])}`);
    check(a.email.settings === false && a.email.ready === false, `email with no settings reads ${JSON.stringify(a.email)}`);
    check(a.email.fix.some((f) => f.includes('email.json')), `email's fix does not name email.json: ${JSON.stringify(a.email.fix)}`);
    check(a.frequency.site === SITE && a.frequency.outcomes_secret === false && a.frequency.ready === false, `frequency reads ${JSON.stringify(a.frequency)}`);
    check(a.frequency.fix.some((f) => f.includes('crd_frequencyoutcomes')), `frequency's fix does not name crd_frequencyoutcomes: ${JSON.stringify(a.frequency.fix)}`);
    check(a.ga4.property_id === '539919559' && a.ga4.credential === 'crd_ga4paidads' && a.ga4.key === false && a.ga4.ready === false, `ga4 reads ${JSON.stringify(a.ga4)}`);
    check(a.ga4.fix.some((f) => f.includes('crd_ga4paidads')), `ga4's fix does not name crd_ga4paidads: ${JSON.stringify(a.ga4.fix)}`);

    // 2. Secrets, the sender's settings and a fresh pass.
    mkdirSync(join(home, 'creds'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, 'creds', 'crd_frequencyoutcomes'), `${SECRET_OUTCOMES}\n`, { mode: 0o600 });
    writeFileSync(join(home, 'creds', 'crd_ga4paidads'), `${SECRET_GA4}\n`, { mode: 0o600 });
    mkdirSync(join(home, 'senders', 'email'), { recursive: true });
    writeFileSync(
      join(home, 'senders', 'email.json'),
      JSON.stringify({
        mailboxes: { personal: { address: ADDRESS, name: 'Owner' } },
        routes: { frequency: 'personal' },
        postal: '1 Main St, Town, ST 00000',
        claim: { url: 'https://frequency.example/api/webhooks/flowweb-claim' },
      }),
    );
    writeFileSync(join(home, 'senders', 'email', 'last-pass.json'), JSON.stringify({ at: new Date().toISOString(), ok: true, sent: 0 }));
    const second = await read();
    check(second.status === 200, `GET /v1/connections answered ${second.status} the second time`);
    check(!second.text.includes(SECRET_OUTCOMES) && !second.text.includes(SECRET_GA4), 'a secret value appears in GET /v1/connections');
    const b = second.json?.data ?? {};
    check(b.frequency.outcomes_secret === true && b.frequency.ready === true && b.frequency.fix.length === 0, `frequency with its secret reads ${JSON.stringify(b.frequency)}`);
    check(b.ga4.key === true && b.ga4.ready === true && b.ga4.fix.length === 0, `ga4 with its key reads ${JSON.stringify(b.ga4)}`);
    const e = b.email;
    check(e.settings === true && e.postal === true && e.running === true && typeof e.last_pass_at === 'string', `email with settings and a pass reads ${JSON.stringify(e)}`);
    check(e.claim_url === 'https://frequency.example/api/webhooks/flowweb-claim', `email's claim_url is ${e.claim_url}`);
    check(Array.isArray(e.mailboxes) && e.mailboxes.length === 1 && e.mailboxes[0].address === ADDRESS && e.mailboxes[0].password === false, `mailboxes read ${JSON.stringify(e.mailboxes)}`);
    check(e.ready === false && e.fix.some((f) => f.includes(ADDRESS)), `email with no saved password should not be ready, and its fix should name ${ADDRESS}: ${JSON.stringify(e)}`);

    const { cookie } = await pair(fwd.port, fwd.pairingCode);
    const browser = await read({ cookie });
    check(browser.status === 200, `a paired browser reading /v1/connections answered ${browser.status}`);
    const none = await api(fwd.port, 'GET', '/v1/connections', {});
    check(none.status === 401 || none.status === 403, `/v1/connections with no session answered ${none.status}`);
  } finally {
    await fwd.stop();
  }

  // 3. The relay.
  const relay = readFileSync(join(root, 'hosted/relay/fw-relay.mjs'), 'utf8');
  check(/['"`]\/connections['"`]/.test(relay), 'hosted/relay/fw-relay.mjs does not mirror /connections');

  // 4. The Settings section.
  const mods = join(root, 'packages/web/node_modules');
  const cfgFile = join(tmpDir('connections'), 'vitest.config.mjs');
  writeFileSync(
    cfgFile,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/settings/connections.spec.tsx')], testTimeout: 30000 },
    }).replace(/}$/, '')}, resolve: { alias: [
      { find: /^react(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react`)} + '$1' },
      { find: /^react-dom(\\/.*)?$/, replacement: ${JSON.stringify(`${mods}/react-dom`)} + '$1' },
      { find: '@testing-library/react', replacement: ${JSON.stringify(`${mods}/@testing-library/react`)} },
    ] } };\n`,
  );
  const out = spawnSync(join(root, 'node_modules/.bin/vitest'), ['run', '--config', cfgFile], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
  const failed = text.split('\n').filter((l) => /✗|×|FAIL|AssertionError|Error:/.test(l)).slice(0, 8);
  check(out.status === 0, `the Settings checks failed (exit ${out.status}):\n${failed.join('\n') || text.slice(-800)}`);
  check(/Tests\s+3 passed/.test(text), `expected 3 Settings checks to pass:\n${text.slice(-400)}`);
});
