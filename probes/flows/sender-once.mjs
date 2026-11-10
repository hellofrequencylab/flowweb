// Probe for FW-C-047 (the email sender never sends one message twice when Gmail's answer is lost):
// `pnpm probe flows/sender-once`. Tier 0.
// Surfaces: senders/email.mjs run with node and --once against a fresh FW_HOME, a local SMTP server
// standing in for Gmail, the outbox folders $FW_HOME/outbox/<flow>/ and the sent record
// $FW_HOME/senders/email/sent.jsonl.
// The surface this probe expects:
//   Before the sender hands over the message text (the final "." of DATA) it writes a line for the item
//   to sent.jsonl, so the item and its address count as written to from that moment. When the server
//   then confirms, the item moves to sent/ as before. When the connection drops or times out after the
//   message text went over, the sender cannot know whether Gmail kept it: the item moves to failed/ with
//   a reason saying it may have been delivered, and it is never sent again. A drop before the message
//   text (at the greeting, sign-in, MAIL or RCPT) leaves the item in the outbox for a later pass, as
//   before. A pass always ends, even when the server closes the connection without a word.
//
// Proves, in order:
//   1. A drop after the message text: the item moves to failed/ ("may have been delivered") and
//      sent.jsonl names it; a drop at RCPT leaves its item in the outbox; a normal item sends; the pass
//      ends well inside the time limit.
//   2. Next pass: the item dropped at RCPT now sends; a new item to the address whose answer was lost
//      is skipped as already written to; that address received the message text exactly once.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { check, freshHome, missing, probe, root } from '../c0/_lib.mjs';

const NAME = 'flows/sender-once';
const FLOW = 'neighborhood-activation';
const SENDER = join(root, 'senders', 'email.mjs');
const PASS = 'probe-pass-one';
const SRC = 'https://example.com/calendar';
const OPT = `I found your address on ${SRC}. Not interested? Reply "no" and I won't write again.`;

await probe(NAME, async () => {
  if (!existsSync(SENDER)) missing('senders/email.mjs does not exist');
  const home = freshHome('sender-once');
  const box = join(home, 'outbox', FLOW);
  mkdirSync(box, { recursive: true });
  mkdirSync(join(home, 'senders'), { recursive: true });
  const item = (id, to) =>
    writeFileSync(
      join(box, `${id}.json`),
      `${JSON.stringify({ flow: FLOW, id, channel: 'frequency', body: `Hi, I saw your event.\n\n${OPT}`, lead: { to, source_url: SRC, subject: `About ${id}` } }, null, 2)}\n`,
    );

  // A stand-in SMTP server. lost@ gets its message text and then the connection drops with no answer;
  // flaky@ is dropped at RCPT the first time only.
  const texts = [];
  let flakyDrops = 0;
  const server = createServer((sock) => {
    let buf = '';
    let data = null;
    let to = '';
    sock.write('220 probe ESMTP\r\n');
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      for (;;) {
        if (data !== null) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          data += buf.slice(0, end);
          buf = buf.slice(end + 5);
          texts.push({ to, data });
          data = null;
          if (/lost@/i.test(to)) return void sock.destroy();
          sock.write('250 OK queued\r\n');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const up = line.toUpperCase();
        if (up.startsWith('EHLO') || up.startsWith('HELO')) sock.write('250-probe\r\n250 AUTH PLAIN\r\n');
        else if (up.startsWith('AUTH PLAIN')) sock.write('235 2.7.0 Accepted\r\n');
        else if (up.startsWith('MAIL FROM')) sock.write('250 OK\r\n');
        else if (up.startsWith('RCPT TO')) {
          to = line;
          if (/flaky@/i.test(line) && flakyDrops === 0) {
            flakyDrops++;
            return void sock.destroy();
          }
          sock.write('250 OK\r\n');
        } else if (up === 'DATA') {
          data = '';
          sock.write('354 Go ahead\r\n');
        } else if (up === 'QUIT') sock.end('221 Bye\r\n');
        else sock.write('250 OK\r\n');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  writeFileSync(
    join(home, 'senders', 'email.json'),
    JSON.stringify({
      mailboxes: { personal: { address: 'daniel@danieltyack.com', name: 'Daniel Tyack' } },
      routes: { frequency: 'personal' },
      postal: '1 Probe Street, Testville, CA 90000',
      daily_cap: 40,
      per_pass: 20,
      hours: { start: 0, end: 24, days: [0, 1, 2, 3, 4, 5, 6] },
      smtp_url: `smtp://127.0.0.1:${server.address().port}`,
    }),
  );
  const run = () =>
    new Promise((ok) => {
      const t0 = Date.now();
      const c = spawn(process.execPath, [SENDER, '--once'], {
        env: { PATH: process.env.PATH, HOME: home, FW_HOME: home, FW_EMAIL_PASSWORD_PERSONAL: PASS },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      c.stdout.on('data', (d) => {
        out += d;
      });
      c.stderr.on('data', (d) => {
        out += d;
      });
      const t = setTimeout(() => c.kill('SIGKILL'), 20000);
      c.on('close', (code, signal) => {
        clearTimeout(t);
        ok({ code, signal, out, ms: Date.now() - t0 });
      });
    });
  const isIn = (dir, id) => existsSync(join(box, dir, `${id}.json`));
  const inBox = () => readdirSync(box).filter((x) => x.endsWith('.json')).sort();
  const lost = () => texts.filter((m) => /lost@/i.test(m.to)).length;

  try {
    // ---- 1. a lost answer ---------------------------------------------------------------------------
    item('a-lost', 'lost@example.com');
    item('b-flaky', 'flaky@example.com');
    item('c-ok', 'ok@example.com');
    const r1 = await run();
    check(r1.signal === null && r1.ms < 15000, `the pass did not end on its own (${r1.ms} ms): ${r1.out.slice(0, 300)}`);
    check(isIn('failed', 'a-lost'), `the item whose answer was lost is not in failed/; outbox: ${inBox()}`);
    check(
      /may have been delivered/i.test(readFileSync(join(box, 'failed', 'a-lost.json'), 'utf8')),
      'failed/a-lost.json does not say the message may have been delivered',
    );
    const log = join(home, 'senders', 'email', 'sent.jsonl');
    check(existsSync(log) && /"a-lost"/.test(readFileSync(log, 'utf8')), 'sent.jsonl does not name the item whose answer was lost');
    check(inBox().includes('b-flaky.json'), 'an item dropped at RCPT left the outbox');
    check(isIn('sent', 'c-ok'), 'a normal item did not send');

    // ---- 2. never twice ------------------------------------------------------------------------------
    item('d-lost-again', 'lost@example.com');
    const r2 = await run();
    check(r2.signal === null, `the second pass did not end: ${r2.out.slice(0, 300)}`);
    check(isIn('sent', 'b-flaky'), 'the item dropped at RCPT did not send on the next pass');
    check(isIn('skipped', 'd-lost-again'), 'a new item to the address whose answer was lost was not skipped');
    check(lost() === 1, `the address whose answer was lost received the message text ${lost()} times`);
    check(inBox().length === 0, `left in the outbox: ${JSON.stringify(inBox())}`);
  } finally {
    server.close();
  }
});
