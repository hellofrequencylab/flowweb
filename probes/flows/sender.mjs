// Probe for FW-C-042 (a sender outside Core emails Autopilot hunt messages from the Owner's own mailboxes):
// `pnpm probe flows/sender`. Tier 0.
// Surfaces: senders/email.mjs run with node and --once against a fresh FW_HOME, a local SMTP server
// standing in for Gmail (smtp.gmail.com), the outbox folders $FW_HOME/outbox/<flow>/ with sent/,
// held/, skipped/ and failed/, the sent record $FW_HOME/senders/email/sent.jsonl, and the flow's
// do-not-contact list in $FW_HOME/flows/<flow>/state.json.
// The surface this probe expects:
//   node senders/email.mjs --once reads $FW_HOME/senders/email.json:
//     { mailboxes: { <key>: { address, name } }, routes: { <outbox channel>: <mailbox key> },
//       postal, daily_cap (per mailbox per day, default 15, at most 40), per_pass (default 1),
//       hours: { start, end, days } (local time; days 0-6, Sunday 0), smtp_url (default
//       smtps://smtp.gmail.com:465; plain smtp:// only to 127.0.0.1) }.
//   A mailbox's app password comes from FW_EMAIL_PASSWORD_<KEY in capitals>, else the macOS Keychain
//   (service flowweb-email, account = the address). Without a readable config or a postal address it
//   exits non-zero and sends nothing.
//   Each pass takes $FW_HOME/outbox/<flow>/*.json in name order. An item is sent only when it carries a
//   lead and its channel has a route (lead.send_from, when it names a mailbox, wins). Per item:
//     - lead.build with a {{claim_url}} slot -> held/ (no claim link can be made yet), not sent;
//     - the address, its @domain or the source page on the flow's do-not-contact list -> skipped/;
//     - the item id or the address already in sent.jsonl -> skipped/ (nothing is ever sent twice);
//     - a body without the "reply no" line or the source page -> failed/;
//     - the mailbox at daily_cap today, outside hours, or no password -> stays for a later pass;
//     - otherwise one SMTP message: From "<name> <address>", To lead.to, Subject lead.subject, the body
//       then the postal address, a List-Unsubscribe mailto header, a Message-ID; then the item moves
//       to sent/ and a line { id, to, from, at, message_id } is added to sent.jsonl;
//     - a 5xx answer from the server -> failed/ with the answer.
//   At most per_pass messages go out per pass. Items with no lead, or on a channel with no route, are
//   left alone. A missing password exits non-zero.
//
// Proves, in order:
//   1. No config, or no postal address: exit non-zero, nothing sent.
//   2. per_pass 1 sends one message, from the routed mailbox, with the right headers and footer.
//   3. A full pass: send_from picks the other mailbox; build is held; do-not-contact and a body without
//      the opt-out are skipped and failed; a 550 fails; the daily cap leaves one waiting; other channels
//      and items without a lead are untouched.
//   4. Nothing twice: a sent item handed off again, or a new item to an address already written to,
//      is skipped, not sent.
//   5. Outside the sending hours nothing goes out; without a password the item stays and it exits
//      non-zero.
//   6. Nothing under packages/ refers to the sender: it is outside Core.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { check, freshHome, missing, probe, root } from '../c0/_lib.mjs';

const NAME = 'flows/sender';
const FLOW = 'neighborhood-activation';
const SENDER = join(root, 'senders', 'email.mjs');
const PASS = { personal: 'probe-pass-one', frequency: 'probe-pass-two' };
const SRC = 'https://example.com/calendar';
const OPT = `I found your address on ${SRC}. Not interested? Reply "no" and I won't write again.`;

await probe(NAME, async () => {
  if (!existsSync(SENDER)) missing('senders/email.mjs does not exist');
  const home = freshHome('sender');
  const box = join(home, 'outbox', FLOW);
  mkdirSync(box, { recursive: true });
  mkdirSync(join(home, 'flows', FLOW), { recursive: true });
  writeFileSync(
    join(home, 'flows', FLOW, 'state.json'),
    JSON.stringify({ do_not_contact: [{ email: 'dnc@example.org', reason: 'asked' }] }),
  );
  const item = (id, to, extra = {}, lead = {}) => {
    const doc = {
      flow: FLOW,
      id,
      channel: 'founder_email',
      body: `Hi there, I saw your event.\n\n${OPT}`,
      lead: { to, source_url: SRC, subject: `About your event ${id}`, build: false, ...lead },
      ...extra,
    };
    writeFileSync(join(box, `${id}.json`), `${JSON.stringify(doc, null, 2)}\n`);
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
  const allDays = { start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] };
  const config = (over = {}) =>
    writeFileSync(
      join(home, 'senders', 'email.json'),
      JSON.stringify({
        mailboxes: {
          personal: { address: 'daniel@danieltyack.com', name: 'Daniel Tyack' },
          frequency: { address: 'hello@frequencylocal.com', name: 'Daniel Tyack' },
        },
        routes: { founder_email: 'personal' },
        postal: '1 Probe Street, Testville, CA 90000',
        daily_cap: 4,
        hours: allDays,
        smtp_url: smtp,
        ...over,
      }),
    );
  const envAll = { FW_EMAIL_PASSWORD_PERSONAL: PASS.personal, FW_EMAIL_PASSWORD_FREQUENCY: PASS.frequency };
  const run = (env = envAll) =>
    new Promise((ok) => {
      const c = spawn(process.execPath, [SENDER, '--once'], {
        env: { PATH: process.env.PATH, HOME: home, FW_HOME: home, ...env },
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
  const inBox = () => readdirSync(box).filter((x) => x.endsWith('.json')).sort();
  const isIn = (dir, id) => existsSync(join(box, dir, `${id}.json`));
  const sentLog = () => {
    const p = join(home, 'senders', 'email', 'sent.jsonl');
    return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };

  try {
    // ---- 1. no config, no postal: nothing sent -------------------------------------------------------
    item('a01', 'alice@example.com');
    const none = await run();
    check(none.code !== 0, 'the sender ran without senders/email.json');
    mkdirSync(join(home, 'senders'), { recursive: true });
    config({ postal: '' });
    const noPostal = await run();
    check(noPostal.code !== 0, 'the sender ran without a postal address');
    check(mail.length === 0, `${mail.length} message(s) went out without a full config`);

    // ---- 2. one message per pass by default, with the right headers ---------------------------------
    item('a02', 'bob@example.com', {}, { send_from: 'frequency' });
    item('a03', 'claim@example.com', { body: `Hi.\n\nYours to claim: {{claim_url}}\n\n${OPT}` }, { build: true });
    item('a04', 'dnc@example.org');
    item('a05', 'noopt@example.com', { body: 'Hi, no way out here.' });
    item('a06', 'bounce@example.com');
    item('a07', 'carol@example.com');
    item('a08', 'dave@example.com');
    item('a09', 'erin@example.com');
    item('a10', 'frank@example.com');
    item('z-other', 'other@example.com', { channel: 'frequency' });
    writeFileSync(join(box, 'z-nolead.json'), JSON.stringify({ flow: FLOW, id: 'z-nolead', channel: 'founder_email', body: 'x' }));
    config();
    const one = await run();
    check(one.code === 0, `a pass exited ${one.code}: ${one.out.slice(0, 300)}`);
    check(mail.length === 1, `per_pass 1 sent ${mail.length} message(s)`);
    const m = mail[0];
    check(/alice@example\.com/.test(m.to ?? ''), `the first message went to ${m.to}`);
    check(m.user === 'daniel@danieltyack.com', `signed in as ${m.user}`);
    check(/^From: "?Daniel Tyack"? <daniel@danieltyack\.com>/m.test(m.data), 'From is not Daniel Tyack <daniel@danieltyack.com>');
    check(/^To: .*alice@example\.com/m.test(m.data), 'To header is missing');
    check(/^Subject: /m.test(m.data), 'Subject header is missing');
    check(/^List-Unsubscribe: <mailto:daniel@danieltyack\.com/m.test(m.data), 'no List-Unsubscribe mailto header');
    check(/^Message-ID: <[^>]+>/m.test(m.data), 'no Message-ID header');
    check(!/^Bcc:/im.test(m.data), 'the message has a Bcc header');
    const text = decodeBody(m.data);
    check(text.includes(OPT) && text.includes('1 Probe Street, Testville'), 'the body lost the opt-out line or the postal address');
    check(isIn('sent', 'a01') && sentLog().some((l) => l.id === 'a01' && l.to === 'alice@example.com'), 'a01 is not in sent/ and sent.jsonl');

    // ---- 3. a full pass -----------------------------------------------------------------------------
    config({ per_pass: 20 });
    const full = await run();
    check(full.code === 0, `a full pass exited ${full.code}: ${full.out.slice(0, 300)}`);
    const bob = mail.find((x) => /bob@/.test(x.to ?? ''));
    check(bob && bob.user === 'hello@frequencylocal.com' && /^From: .*hello@frequencylocal\.com/m.test(bob.data), 'send_from did not pick the frequencylocal.com mailbox');
    check(isIn('held', 'a03') && !mail.some((x) => /claim@/.test(x.to ?? '')), 'the build item was not held');
    check(isIn('skipped', 'a04') && !mail.some((x) => /dnc@/.test(x.to ?? '')), 'the do-not-contact address was not skipped');
    check(isIn('failed', 'a05') && !mail.some((x) => /noopt@/.test(x.to ?? '')), 'a body without the opt-out was not failed');
    check(isIn('failed', 'a06'), 'the 550 bounce is not in failed/');
    check(/550/.test(readFileSync(join(box, 'failed', 'a06.json'), 'utf8')), 'failed/a06.json does not hold the server answer');
    const personal = sentLog().filter((l) => l.from === 'daniel@danieltyack.com');
    check(personal.length === 4, `the personal mailbox sent ${personal.length} today, want the daily cap of 4`);
    check(
      JSON.stringify(inBox()) === JSON.stringify(['a10.json', 'z-nolead.json', 'z-other.json']),
      `left in the outbox: ${JSON.stringify(inBox())}`,
    );

    // ---- 4. nothing twice ---------------------------------------------------------------------------
    const before = mail.length;
    copyFileSync(join(box, 'sent', 'a07.json'), join(box, 'a07.json'));
    item('b01', 'carol@example.com');
    config({ per_pass: 20, daily_cap: 40 });
    const again = await run();
    check(again.code === 0, `the repeat pass exited ${again.code}`);
    check(isIn('skipped', 'a07') && isIn('skipped', 'b01'), 'a re-handed item or a known address was not skipped');
    check(!mail.slice(before).some((x) => /carol@/.test(x.to ?? '')), 'carol@example.com was written to twice');
    check(mail.slice(before).length === 1 && /frank@/.test(mail.at(-1).to ?? ''), 'the waiting item did not go out under a higher cap');

    // ---- 5. hours and passwords ---------------------------------------------------------------------
    item('c01', 'gina@example.com');
    config({ per_pass: 20, daily_cap: 40, hours: { start: 0, end: 24, days: [] } });
    const shut = await run();
    check(shut.code === 0 && inBox().includes('c01.json'), 'an item went out outside the sending hours');
    config({ per_pass: 20, daily_cap: 40 });
    const nopass = await run({});
    check(nopass.code !== 0 && inBox().includes('c01.json'), 'without a password the item did not stay, or the exit was 0');
    check(!mail.some((x) => /gina@/.test(x.to ?? '')), 'gina@example.com was sent to without a password or outside hours');

    // ---- 6. outside Core ----------------------------------------------------------------------------
    const grep = spawnSync('git', ['grep', '-l', 'senders/email', '--', 'packages'], { cwd: root, encoding: 'utf8' });
    const importers = grep.stdout.trim().split('\n').filter(Boolean);
    check(importers.length === 0, `packages refer to the sender: ${importers.join(', ')}`);
  } finally {
    server.close();
  }
});

/** The text of a message: its body after the headers, base64 or quoted-printable decoded if marked so. */
function decodeBody(raw) {
  const i = raw.indexOf('\r\n\r\n');
  const head = raw.slice(0, i);
  const body = raw.slice(i + 4).replace(/^\.\./gm, '.');
  if (/^Content-Transfer-Encoding: base64/im.test(head)) return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (/^Content-Transfer-Encoding: quoted-printable/im.test(head))
    return Buffer.from(
      body.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))),
      'latin1',
    ).toString('utf8');
  return body.replace(/\r\n/g, '\n');
}
