#!/usr/bin/env node
// FW-C-042: the sender for Autopilot hunt messages. It runs on the Owner's Mac, outside Core: fwd never
// runs it and no package refers to it. Each pass reads the outbox and sends at most a few plain
// one-to-one messages from the Owner's own Workspace mailbox through Gmail, so replies reach him.
// Never through Resend: its rules ban cold outreach. Usage: node senders/email.mjs --once
// (launchd runs it every few minutes; see senders/README.md).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import tls from 'node:tls';

const HOME = process.env.FW_HOME || join(process.env.HOME ?? '.', '.flowweb');
const LOG_DIR = join(HOME, 'senders', 'email');
const SENT_LOG = join(LOG_DIR, 'sent.jsonl');
const SLOT = '{{claim_url}}';
const say = (s) => process.stdout.write(`${s}\n`);
const stop = (s) => {
  process.stderr.write(`email sender: ${s}\n`);
  process.exit(1);
};

const readJson = (p, dflt) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return dflt;
  }
};

/** The Owner's sender settings, checked. Exits non-zero when they are missing or unsafe. */
function loadConfig() {
  const c = readJson(join(HOME, 'senders', 'email.json'), null);
  if (!c || typeof c !== 'object') stop(`no readable ${join(HOME, 'senders', 'email.json')}`);
  const postal = typeof c.postal === 'string' ? c.postal.trim() : '';
  if (!postal) stop('postal is required: every message carries a postal address');
  const boxes = c.mailboxes && typeof c.mailboxes === 'object' ? c.mailboxes : {};
  for (const [k, b] of Object.entries(boxes))
    if (!/^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(b?.address ?? '')) stop(`mailbox ${k} has no address`);
  const cap = c.daily_cap ?? 15;
  if (!Number.isInteger(cap) || cap < 1 || cap > 40) stop('daily_cap must be a whole number from 1 to 40');
  const perPass = c.per_pass ?? 1;
  if (!Number.isInteger(perPass) || perPass < 1) stop('per_pass must be a whole number of at least 1');
  const smtp = new URL(c.smtp_url ?? 'smtps://smtp.gmail.com:465');
  if (smtp.protocol === 'smtp:' && smtp.hostname !== '127.0.0.1') stop('plain smtp:// is only for 127.0.0.1');
  if (!['smtp:', 'smtps:'].includes(smtp.protocol)) stop('smtp_url must be smtps:// (or smtp:// to 127.0.0.1)');
  const h = c.hours ?? { start: 9, end: 17, days: [1, 2, 3, 4, 5] };
  return { boxes, routes: c.routes ?? {}, postal, cap, perPass, smtp, hours: h };
}

function password(key, address) {
  const env = process.env[`FW_EMAIL_PASSWORD_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
  if (env) return env;
  if (process.platform !== 'darwin') return null;
  try {
    const w = execFileSync('security', ['find-generic-password', '-s', 'flowweb-email', '-a', address, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return w.trim() || null;
  } catch {
    return null;
  }
}

const inHours = (h, now) =>
  Array.isArray(h.days) && h.days.includes(now.getDay()) && now.getHours() >= h.start && now.getHours() < h.end;

/** Do-not-contact entries as lower-case strings; fwd stores strings, older files may hold objects. */
function doNotContact(flow) {
  const s = readJson(join(HOME, 'flows', flow, 'state.json'), {});
  const list = Array.isArray(s.do_not_contact) ? s.do_not_contact : [];
  return new Set(
    list
      .map((x) => (typeof x === 'string' ? x : (x?.email ?? x?.url ?? '')))
      .map((x) => String(x).trim().toLowerCase())
      .filter(Boolean),
  );
}

function move(dir, file, sub, extra) {
  mkdirSync(join(dir, sub), { recursive: true });
  if (extra) {
    const doc = readJson(join(dir, file), {});
    writeFileSync(join(dir, file), `${JSON.stringify({ ...doc, sender: extra }, null, 2)}\n`);
  }
  renameSync(join(dir, file), join(dir, sub, file));
}

// ---- a small SMTP client: implicit TLS to Gmail, AUTH PLAIN, one message per connection --------------
function smtpSend(url, user, pass, from, to, data) {
  return new Promise((resolve) => {
    const port = Number(url.port) || (url.protocol === 'smtps:' ? 465 : 25);
    const sock =
      url.protocol === 'smtps:'
        ? tls.connect({ host: url.hostname, port, servername: url.hostname })
        : net.connect({ host: url.hostname, port });
    const steps = [
      () => `EHLO flowweb.local`,
      () => `AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString('base64')}`,
      () => `MAIL FROM:<${from}>`,
      () => `RCPT TO:<${to}>`,
      () => 'DATA',
      () => `${data.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')}\r\n.`,
      () => 'QUIT',
    ];
    let buf = '';
    let i = -1;
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(30_000, () => finish({ ok: false, temp: true, answer: 'timed out' }));
    sock.on('error', (e) => finish({ ok: false, temp: true, answer: String(e.message) }));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      const lines = buf.split('\r\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (/^\d{3}-/.test(line)) continue;
        const code = Number(line.slice(0, 3));
        // Before RCPT the fault is the sign-in or the server, not the address: try the item again later.
        if (code >= 400) return finish({ ok: false, temp: code < 500 || i < 3, auth: i < 3, answer: line });
        if (i === 5) return finish({ ok: true, answer: line });
        i++;
        sock.write(`${steps[i]()}\r\n`);
      }
    });
  });
}

const enc = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);

function message(box, to, subject, text, id) {
  const domain = box.address.split('@')[1];
  const mid = `<${id}.${randomBytes(6).toString('hex')}@${domain}>`;
  const body = Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const head = [
    `From: "${(box.name ?? '').replace(/"/g, '')}" <${box.address}>`,
    `To: <${to}>`,
    `Subject: ${enc(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${mid}`,
    `List-Unsubscribe: <mailto:${box.address}?subject=unsubscribe>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  return { mid, data: `${head.join('\r\n')}\r\n\r\n${body}` };
}

async function main() {
  if (!process.argv.includes('--once')) stop('run with --once (launchd repeats it)');
  const cfg = loadConfig();
  const now = new Date();
  const today = now.toDateString();
  mkdirSync(LOG_DIR, { recursive: true });
  const log = existsSync(SENT_LOG)
    ? readFileSync(SENT_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const sentIds = new Set(log.map((l) => l.id));
  const sentTo = new Set(log.map((l) => String(l.to).toLowerCase()));
  const todayBy = {};
  for (const l of log) if (new Date(l.at).toDateString() === today) todayBy[l.from] = (todayBy[l.from] ?? 0) + 1;
  const open = inHours(cfg.hours, now);
  let sent = 0;
  let noPass = false;
  const outbox = join(HOME, 'outbox');
  const flows = existsSync(outbox) ? readdirSync(outbox).filter((f) => !f.startsWith('.')).sort() : [];
  for (const flow of flows) {
    const dir = join(outbox, flow);
    let dnc = null;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      const item = readJson(join(dir, file), null);
      const lead = item?.lead;
      if (!lead || typeof lead !== 'object') continue;
      const key = cfg.boxes[lead.send_from] ? lead.send_from : cfg.routes[item.channel];
      const box = key ? cfg.boxes[key] : null;
      if (!box) continue;
      const to = String(lead.to ?? '').trim().toLowerCase();
      const src = String(lead.source_url ?? '');
      const body = String(item.body ?? '');
      dnc ??= doNotContact(flow);
      if (lead.build && body.includes(SLOT)) {
        move(dir, file, 'held', { reason: 'needs a claim link, which no builder makes yet', at: now.toISOString() });
        say(`held ${item.id}: needs a claim link`);
      } else if ([to, `mailto:${to}`, `@${to.split('@')[1]}`, src.toLowerCase()].some((k) => dnc.has(k))) {
        move(dir, file, 'skipped', { reason: 'do_not_contact', at: now.toISOString() });
        say(`skipped ${item.id}: on the do-not-contact list`);
      } else if (sentIds.has(item.id) || sentTo.has(to)) {
        move(dir, file, 'skipped', { reason: 'already_sent', at: now.toISOString() });
        say(`skipped ${item.id}: ${to} was already written to`);
      } else if (!/reply "?no"?/i.test(body) || !src || !body.includes(src)) {
        move(dir, file, 'failed', { reason: 'the body has no reply-no line or source page', at: now.toISOString() });
        say(`failed ${item.id}: no opt-out line or source page`);
      } else if (!open || sent >= cfg.perPass || (todayBy[box.address] ?? 0) >= cfg.cap) {
        continue;
      } else {
        const pass = password(key, box.address);
        if (!pass) {
          noPass = true;
          process.stderr.write(`email sender: no app password for ${box.address} (mailbox ${key})\n`);
          continue;
        }
        const subject = String(lead.subject ?? '').replace(/[\r\n]+/g, ' ').trim() || 'Hello from a neighbor';
        const m = message(box, to, subject, `${body}\n\n${cfg.postal}\n`, item.id);
        const r = await smtpSend(cfg.smtp, box.address, pass, box.address, to, m.data);
        if (r.ok) {
          const at = new Date().toISOString();
          appendFileSync(SENT_LOG, `${JSON.stringify({ id: item.id, to, from: box.address, at, message_id: m.mid })}\n`);
          sentIds.add(item.id);
          sentTo.add(to);
          todayBy[box.address] = (todayBy[box.address] ?? 0) + 1;
          sent++;
          move(dir, file, 'sent', { from: box.address, at, message_id: m.mid });
          say(`sent ${item.id} to ${to} from ${box.address}`);
        } else if (!r.temp) {
          move(dir, file, 'failed', { reason: 'the mail server refused it', answer: r.answer, at: now.toISOString() });
          say(`failed ${item.id}: ${r.answer}`);
        } else {
          process.stderr.write(`email sender: ${item.id} will be tried again: ${r.answer}\n`);
          if (r.auth) noPass = true;
        }
      }
    }
  }
  if (!open) say('outside the sending hours: nothing sent');
  if (noPass) process.exit(1);
}

await main();
