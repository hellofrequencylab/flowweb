// Probe for FW-C-095 (the email sender's settings from Settings, not only by writing senders/email.json on the
// machine): `pnpm probe settings/sender-settings`.
// probe-timeout-s: 240
// Tier 0.
// Surfaces: a real fwd on a fresh FW_HOME with FW_KEYCHAIN=off and a paired browser session,
// hosted/server/requests.mjs (pure), hosted/supabase/migrations/0008_flowweb_sender_settings.sql, and the
// Settings section packages/web/src/settings/ConnectionsSettings.tsx (its checks are in
// probes/settings/sender-settings.spec.tsx, vitest in jsdom against a fetch stub).
//
// The surface this probe expects:
//   POST /v1/connections/email { mailboxes: [{ key, address, name }], postal, daily_cap, per_pass,
//     hours: { start, end, days } } writes $FW_HOME/senders/email.json (mode 0600), keeping other keys,
//     dropping routes to removed mailboxes and routing frequency to the first mailbox when nothing does.
//   GET /v1/connections returns email.values.
//   requestOf: POST /connections/email -> connection.email, flow 'all', draft_id null; fwdCallFor maps back.
//
// Proves, in order:
//   1. A real fwd takes the settings from a browser session, writes them and keeps the rest; shows them.
//   2. It refuses bad values and any password field; no session may not write.
//   3. The site queues connection.email with a checked payload, the relay calls the same route, 0008 allows it.
//   4. The Settings checks pass (3 of them).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, freshHome, missing, probe, root, tmpDir } from '../c0/_lib.mjs';
import { api, pair, startFwd } from '../lib/fwd.mjs';

const NAME = 'settings/sender-settings';
const MIGRATION = 'hosted/supabase/migrations/0008_flowweb_sender_settings.sql';
const EARLIER = 'hosted/supabase/migrations/0007_flowweb_flow_ai.sql';
const imp = (p) => import(pathToFileURL(join(root, p)).href);
const GOOD = {
  mailboxes: [{ key: 'personal', address: 'owner@example.com', name: 'Owner Name' }],
  postal: '1 Main St, Town, ST 00000',
  daily_cap: 10,
  per_pass: 1,
  hours: { start: 9, end: 17, days: [1, 2, 3, 4, 5] },
};

await probe(NAME, async () => {
  if (!existsSync(join(root, MIGRATION))) missing(`${MIGRATION} does not exist (row FW-C-095)`);

  // 1. A real fwd and its paired browser session.
  const home = freshHome('sender-settings');
  mkdirSync(join(home, 'senders'), { recursive: true });
  const file = join(home, 'senders', 'email.json');
  writeFileSync(
    file,
    JSON.stringify({
      mailboxes: { old: { address: 'old@example.com' } },
      routes: { frequency: 'old', founder_email: 'old' },
      postal: 'Old address',
      claim: { url: 'https://frequency.example/api/webhooks/flowweb-claim' },
      smtp_url: 'smtps://smtp.gmail.com:465',
    }),
  );
  const fwd = await startFwd(home, { env: { FW_VENDOR: 'fake', FW_KEYCHAIN: 'off' } });
  try {
    const { cookie } = await pair(fwd.port, fwd.pairingCode);
    const post = (body, auth = { cookie }) => api(fwd.port, 'POST', '/v1/connections/email', { auth, body });
    const saved = await post(GOOD);
    check(saved.status === 200, `saving the sender's settings from the browser answered ${saved.status}: ${saved.text.slice(0, 200)}`);
    const c = JSON.parse(readFileSync(file, 'utf8'));
    check(c.mailboxes?.personal?.address === 'owner@example.com' && c.mailboxes.personal.name === 'Owner Name' && !c.mailboxes.old, `mailboxes became ${JSON.stringify(c.mailboxes)}`);
    check(c.postal === GOOD.postal && c.daily_cap === 10 && c.per_pass === 1, `postal and caps became ${JSON.stringify([c.postal, c.daily_cap, c.per_pass])}`);
    check(JSON.stringify(c.hours) === JSON.stringify(GOOD.hours), `hours became ${JSON.stringify(c.hours)}`);
    check(c.claim?.url === 'https://frequency.example/api/webhooks/flowweb-claim' && c.smtp_url === 'smtps://smtp.gmail.com:465', 'claim or smtp_url was not kept');
    check(JSON.stringify(c.routes) === JSON.stringify({ frequency: 'personal' }), `routes became ${JSON.stringify(c.routes)}, want only frequency -> personal`);
    if (process.platform !== 'win32') check((statSync(file).mode & 0o077) === 0, `email.json has mode ${(statSync(file).mode & 0o777).toString(8)}, want 0600`);
    const shown = (await api(fwd.port, 'GET', '/v1/connections', { auth: fwd.token })).json?.data?.email?.values;
    check(shown && shown.postal === GOOD.postal && shown.daily_cap === 10 && shown.mailboxes?.[0]?.key === 'personal' && shown.mailboxes[0].name === 'Owner Name', `email.values reads ${JSON.stringify(shown)}`);
    check(JSON.stringify(shown.hours) === JSON.stringify(GOOD.hours), `email.values.hours reads ${JSON.stringify(shown?.hours)}`);

    // 2. Refusals.
    const bad = [
      ['a bad address', { ...GOOD, mailboxes: [{ key: 'personal', address: 'not-an-address', name: 'x' }] }],
      ['no mailbox', { ...GOOD, mailboxes: [] }],
      ['a bad mailbox key', { ...GOOD, mailboxes: [{ key: 'Bad Key', address: 'a@example.com', name: 'x' }] }],
      ['the same key twice', { ...GOOD, mailboxes: [GOOD.mailboxes[0], GOOD.mailboxes[0]] }],
      ['an empty postal address', { ...GOOD, postal: '  ' }],
      ['daily_cap 41', { ...GOOD, daily_cap: 41 }],
      ['per_pass 0', { ...GOOD, per_pass: 0 }],
      ['start after end', { ...GOOD, hours: { start: 17, end: 9, days: [1] } }],
      ['day 7', { ...GOOD, hours: { start: 9, end: 17, days: [7] } }],
      ['no days', { ...GOOD, hours: { start: 9, end: 17, days: [] } }],
      ['a password field', { ...GOOD, password: 'abcd efgh ijkl mnop' }],
      ['a mailbox password', { ...GOOD, mailboxes: [{ ...GOOD.mailboxes[0], password: 'x' }] }],
    ];
    for (const [what, body] of bad) {
      const r = await post(body);
      check(r.status === 400, `${what} answered ${r.status}, want 400`);
    }
    const none = await post(GOOD, null);
    check(none.status === 401 || none.status === 403, `saving with no session answered ${none.status}`);
    check(!readFileSync(file, 'utf8').includes('abcd efgh'), 'a refused password reached email.json');
  } finally {
    await fwd.stop();
  }

  // 3. The site queue and migration 0008.
  const { requestOf, fwdCallFor } = await imp('hosted/server/requests.mjs');
  const r = requestOf('POST', '/connections/email', { ...GOOD, postal: `  ${GOOD.postal}  `, extra: 'x' });
  check(r && !r.error && r.kind === 'connection.email' && r.flow === 'all' && r.draft_id === null, `the settings became ${JSON.stringify(r)}`);
  check(JSON.stringify(r.payload) === JSON.stringify(GOOD), `connection.email carries ${JSON.stringify(r.payload)}`);
  const call = fwdCallFor({ id: 'r1', ...r });
  check(call?.method === 'POST' && call.path === '/connections/email' && JSON.stringify(call.body) === JSON.stringify(GOOD), `the relay calls ${JSON.stringify(call)}`);
  check(requestOf('POST', '/connections/email', { ...GOOD, daily_cap: 99 })?.error, 'daily_cap 99 was queued');
  check(requestOf('POST', '/connections/email', { ...GOOD, password: 'x' })?.error, 'a password was queued');
  check(fwdCallFor({ id: 'r2', ...r, payload: { ...GOOD, per_pass: 0 } }) === null, 'the relay would call fwd with per_pass 0');
  const sql = readFileSync(join(root, MIGRATION), 'utf8');
  const earlier = [...readFileSync(join(root, EARLIER), 'utf8').matchAll(/'((?:draft|flow|supervisor|hunt|project)\.[a-z]+)'/g)].map((m) => m[1]);
  for (const k of [...new Set([...earlier, 'connection.email'])]) check(sql.includes(`'${k}'`), `${MIGRATION} does not allow the kind ${k}`);

  // 4. The Settings section.
  const mods = join(root, 'packages/web/node_modules');
  const cfgFile = join(tmpDir('sender-settings'), 'vitest.config.mjs');
  writeFileSync(
    cfgFile,
    `export default ${JSON.stringify({
      root: join(root, 'packages/web'),
      esbuild: { jsx: 'automatic' },
      test: { environment: 'jsdom', include: [join(root, 'probes/settings/sender-settings.spec.tsx')], testTimeout: 30000 },
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
