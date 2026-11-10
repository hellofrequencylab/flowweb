// Probe for FW-C-044 (the email sender gets a claim link from Frequency before it mails a build item):
// `pnpm probe flows/claim`. Tier 0.
// Surfaces: senders/email.mjs run with node and --once against a fresh FW_HOME, a local SMTP server
// standing in for Gmail, a local HTTP server standing in for Frequency's /api/webhooks/flowweb-claim, and
// the outbox folders $FW_HOME/outbox/<flow>/ with sent/, skipped/, held/ and failed/.
// The surface this probe expects:
//   $FW_HOME/senders/email.json may hold claim: { url }. The secret comes from FW_CLAIM_SECRET, else the
//   macOS Keychain (service flowweb-claim, account frequency). Without claim.url a build item is held, as
//   before. With it, a build item that is otherwise ready to go (in hours, under the cap, signed in) is
//   first POSTed to claim.url as the outbox file's bytes, unchanged, with x-flowweb-timestamp (unix
//   seconds) and x-flowweb-signature (hex HMAC-SHA256 of `${timestamp}.${body}` under the secret). The
//   answer decides:
//     built (200, with claimUrl) -> every {{claim_url}} in the body becomes claimUrl and the message is sent;
//     suppressed -> skipped/; refused or HTTP 400/422 -> failed/ with the answer;
//     off, HTTP 5xx or no answer -> the item stays for a later pass.
//   Without the secret the build item stays and the sender exits non-zero. Non-build items are unchanged.
//
// Proves, in order:
//   1. Without claim.url a build item is held and nothing is posted (the FW-C-042 behaviour).
//   2. Without the secret build items stay, nothing is posted, and the exit is non-zero.
//   3. With both: each build item is posted once, signed and unchanged; built is sent with its claim link
//      and no slot left; suppressed is skipped; refused fails; off and a 500 stay; a plain item still sends.
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as httpServer } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { check, freshHome, missing, probe, root } from '../c0/_lib.mjs';

const NAME = 'flows/claim';
const FLOW = 'neighborhood-activation';
const SENDER = join(root, 'senders', 'email.mjs');
const PASS = { personal: 'probe-pass-one' };
const SECRET = 'probe-claim-secret-not-real';
const SRC = 'https://example.com/calendar';
const OPT = `I found your address on ${SRC}. Not interested? Reply "no" and I won't write again.`;
const CLAIM = 'https://frequencylocal.com/events/claim/tok-';
const ANSWERS = {
  'b-ok': [200, { status: 'built', claimUrl: `${CLAIM}ok`, eventUrl: 'https://frequencylocal.com/events/x' }],
  'b-supp': [200, { status: 'suppressed' }],
  'b-bad': [422, { status: 'refused', reason: 'the event page could not be built' }],
  'b-off': [200, { status: 'off' }],
  'b-500': [500, { status: 'error' }],
};

await probe(NAME, async () => {
  if (!existsSync(SENDER)) missing('senders/email.mjs does not exist');
  const home = freshHome('claim');
  const box = join(home, 'outbox', FLOW);
  mkdirSync(box, { recursive: true });
  mkdirSync(join(home, 'senders'), { recursive: true });
  const files = {};
  const item = (id, build) => {
    const doc = {
      flow: FLOW,
      id,
      channel: 'frequency',
      body: build ? `Hi, I saw your event.\n\nIt is yours to claim: {{claim_url}}\n\n${OPT}` : `Hi, I saw your event.\n\n${OPT}`,
      lead: { to: `${id}@example.com`, source_url: SRC, subject: `About ${id}`, build },
    };
    files[id] = `${JSON.stringify(doc, null, 2)}\n`;
    writeFileSync(join(box, `${id}.json`), files[id]);
  };

  // ---- a stand-in SMTP server -----------------------------------------------------------------------
  const mail = [];
  const server = createServer((sock) => {
    let buf = '';
    let data = null;
    let cur = {};
    sock.write('220 probe ESMTP\r\n');
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      for (;;) {
        if (data !== null) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          data += buf.slice(0, end);
          buf = buf.slice(end + 5);
          mail.push({ ...cur, data });
          data = null;
          sock.write('250 OK queued\r\n');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const up = line.toUpperCase();
        if (up.startsWith('EHLO') || up.startsWith('HELO')) sock.write('250-probe\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (up.startsWith('AUTH PLAIN')) {
          const [, user, pass] = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString('utf8').split('\0');
          cur = { user };
          const ok = Object.values(PASS).includes(pass);
          sock.write(ok ? '235 2.7.0 Accepted\r\n' : '535 5.7.8 Bad credentials\r\n');
        } else if (up.startsWith('MAIL FROM')) {
          cur.from = line;
          sock.write('250 OK\r\n');
        } else if (up.startsWith('RCPT TO')) {
          cur.to = line;
          sock.write(/bounce@/i.test(line) ? '550 5.1.1 No such user\r\n' : '250 OK\r\n');
        } else if (up === 'DATA') {
          data = '';
          sock.write('354 Go ahead\r\n');
        } else if (up === 'QUIT') {
          sock.end('221 Bye\r\n');
        } else if (up === 'RSET' || up === 'NOOP') sock.write('250 OK\r\n');
        else sock.write('502 Not implemented\r\n');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const smtp = `smtp://127.0.0.1:${server.address().port}`;

  const posts = [];
  const claimSrv = httpServer((req, res) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
    });
    req.on('end', () => {
      const ts = String(req.headers['x-flowweb-timestamp'] ?? '');
      const sig = String(req.headers['x-flowweb-signature'] ?? '');
      const good = createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
      let id = '';
      try {
        id = JSON.parse(body).id;
      } catch {}
      posts.push({ id, body, signed: sig === good && Math.abs(Date.now() / 1000 - Number(ts)) < 300 });
      const [code, answer] = ANSWERS[id] ?? [400, { status: 'refused', reason: 'unknown' }];
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise((ok) => claimSrv.listen(0, '127.0.0.1', ok));
  const claimUrl = `http://127.0.0.1:${claimSrv.address().port}/api/webhooks/flowweb-claim`;
  const config = (over = {}) =>
    writeFileSync(
      join(home, 'senders', 'email.json'),
      JSON.stringify({
        mailboxes: { personal: { address: 'daniel@danieltyack.com', name: 'Daniel Tyack' } },
        routes: { frequency: 'personal' },
        postal: '1 Probe Street, Testville, CA 90000',
        daily_cap: 40,
        per_pass: 20,
        hours: { start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] },
        smtp_url: smtp,
        ...over,
      }),
    );
  const run = (env) =>
    new Promise((ok) => {
      const c = spawn(process.execPath, [SENDER, '--once'], {
        env: { PATH: process.env.PATH, HOME: home, FW_HOME: home, FW_EMAIL_PASSWORD_PERSONAL: PASS.personal, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      c.stdout.on('data', (d) => {
        out += d;
      });
      c.stderr.on('data', (d) => {
        out += d;
      });
      const t = setTimeout(() => c.kill('SIGKILL'), 30000);
      c.on('close', (code) => {
        clearTimeout(t);
        ok({ code, out });
      });
    });
  const isIn = (dir, id) => existsSync(join(box, dir, `${id}.json`));
  const inBox = () => readdirSync(box).filter((x) => x.endsWith('.json')).sort();

  try {
    // ---- 1. no claim url: held, as before ------------------------------------------------------------
    item('b-held', true);
    config();
    const r1 = await run({ FW_CLAIM_SECRET: SECRET });
    check(r1.code === 0, `a pass without claim.url exited ${r1.code}: ${r1.out.slice(0, 300)}`);
    check(isIn('held', 'b-held') && posts.length === 0 && mail.length === 0, 'without claim.url a build item was not simply held');

    // ---- 2. no secret: build items stay ---------------------------------------------------------------
    for (const id of Object.keys(ANSWERS)) item(id, true);
    item('p-plain', false);
    config({ claim: { url: claimUrl } });
    const r2 = await run({});
    check(r2.code !== 0, 'without the claim secret the sender exited 0');
    check(posts.length === 0, `posted ${posts.length} item(s) without the secret`);
    check(Object.keys(ANSWERS).every((id) => inBox().includes(`${id}.json`)), `build items left the outbox without the secret: ${inBox()}`);
    check(mail.some((m) => /p-plain@/.test(m.to ?? '')), 'a plain item did not send while build items waited');

    // ---- 3. claim links ---------------------------------------------------------------------------------
    const before = mail.length;
    const r3 = await run({ FW_CLAIM_SECRET: SECRET });
    check(r3.code === 0, `the claim pass exited ${r3.code}: ${r3.out.slice(0, 300)}`);
    const ids = posts.map((p) => p.id).sort();
    check(JSON.stringify(ids) === JSON.stringify(Object.keys(ANSWERS).sort()), `posted ${JSON.stringify(ids)}, want each build item once`);
    for (const p of posts) {
      check(p.signed, `${p.id} was not correctly signed`);
      check(p.body === files[p.id], `${p.id} was changed on the way to Frequency`);
    }
    const sent = mail.slice(before);
    check(sent.length === 1 && /b-ok@/.test(sent[0].to ?? ''), `sent ${sent.map((m) => m.to)}, want only b-ok`);
    const text = decodeBody(sent[0].data);
    check(text.includes(`${CLAIM}ok`) && !text.includes('{{claim_url}}'), 'the sent message does not carry its claim link');
    check(isIn('sent', 'b-ok') && isIn('skipped', 'b-supp') && isIn('failed', 'b-bad'), 'built, suppressed and refused did not land in sent/, skipped/ and failed/');
    check(/could not be built/.test(readFileSync(join(box, 'failed', 'b-bad.json'), 'utf8')), 'failed/b-bad.json does not hold the reason');
    check(JSON.stringify(inBox()) === JSON.stringify(['b-500.json', 'b-off.json']), `left in the outbox: ${JSON.stringify(inBox())}`);
  } finally {
    server.close();
    claimSrv.close();
  }
});

/** The text of a base64 message body. */
function decodeBody(raw) {
  const i = raw.indexOf('\r\n\r\n');
  return Buffer.from(raw.slice(i + 4).replace(/\s+/g, ''), 'base64').toString('utf8');
}
