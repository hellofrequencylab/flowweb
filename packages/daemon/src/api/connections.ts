// FW-C-094: is email sending, the Frequency link and Google Analytics set up on this machine? Read from
// FW_HOME, the repo's paid-ads config, fwd's env and the keychain. A secret is only checked for presence:
// the keychain is asked without -w and its output is discarded, and a creds file is only stat'ed, so no
// secret value is ever read into this answer. FW_KEYCHAIN=off leaves the keychain out (tests).
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFlow as loadAds } from '../flows/paid-ads.ts';
import { ga4Of, readPullStatus } from '../flows/paid-ads-ga4.ts';
import { senderStatus } from '../overseer/sender.ts';

const OUTCOMES = 'crd_frequencyoutcomes';
const CACHE_MS = 5 * 60e3;
const seen = new Map<string, { at: number; has: boolean }>();

/** Whether the keychain holds an item. Presence only: the value is never read by this process. */
function keychainHas(service: string, account: string): boolean {
  if (process.env.FW_KEYCHAIN === 'off') return false;
  const id = `${service}\u0000${account}`;
  const hit = seen.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.has;
  let has = false;
  try {
    const [cmd, args] =
      process.platform === 'darwin'
        ? ['security', ['find-generic-password', '-s', service, '-a', account]]
        : ['secret-tool', ['lookup', 'service', service, 'handle', account]];
    has = spawnSync(cmd, args, { stdio: 'ignore', timeout: 5000 }).status === 0;
  } catch {
    has = false;
  }
  seen.set(id, { at: Date.now(), has });
  return has;
}

function credSaved(home: string, handle: string): boolean {
  try {
    const st = statSync(join(home, 'creds', handle));
    if (st.isFile() && st.size > 0) return true;
  } catch {
    // not in the file backend
  }
  return keychainHas('flowweb', handle);
}

/** The command that saves a secret under a credential handle on this machine. */
function saveCred(home: string, handle: string): string {
  if (process.platform === 'darwin') return `security add-generic-password -s flowweb -a ${handle} -w`;
  return `install -m 600 /dev/stdin ${join(home, 'creds', handle)}`;
}

interface EmailCfg {
  mailboxes?: Record<string, { address?: unknown }>;
  postal?: unknown;
  claim?: { url?: unknown };
}

function emailOf(home: string, now: Date) {
  const file = join(home, 'senders', 'email.json');
  let cfg: EmailCfg | null = null;
  try {
    const c = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (c && typeof c === 'object') cfg = c as EmailCfg;
  } catch {
    cfg = null;
  }
  const beat = senderStatus(home, now);
  const fix: string[] = [];
  const mailboxes = Object.entries(cfg?.mailboxes ?? {})
    .filter(([, m]) => typeof m?.address === 'string')
    .map(([key, m]) => {
      const address = String(m.address);
      const envName = `FW_EMAIL_PASSWORD_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      const password = Boolean(process.env[envName]) || keychainHas('flowweb-email', address);
      if (!password)
        fix.push(
          process.platform === 'darwin'
            ? `security add-generic-password -s flowweb-email -a ${address} -w`
            : `Set ${envName} for the sender to the app password for ${address}`,
        );
      return { address, password };
    });
  const postal = typeof cfg?.postal === 'string' && cfg.postal.trim().length > 0;
  const claim_url = typeof cfg?.claim?.url === 'string' ? cfg.claim.url : null;
  const claim_secret = Boolean(process.env.FW_CLAIM_SECRET) || keychainHas('flowweb-claim', 'frequency');
  if (!cfg)
    fix.unshift(
      `Write ${file} with your mailbox, postal address and hours (senders/README.md, Set up step 3)`,
    );
  else if (mailboxes.length === 0) fix.unshift(`Add a mailbox with its address to ${file}`);
  if (cfg && !postal) fix.push(`Add your postal address as "postal" in ${file}`);
  if (claim_url && !claim_secret)
    fix.push(
      process.platform === 'darwin'
        ? 'security add-generic-password -s flowweb-claim -a frequency -w'
        : 'Set FW_CLAIM_SECRET for the sender',
    );
  if (!beat.installed) fix.push('node senders/email.mjs --once');
  const ready =
    cfg !== null &&
    mailboxes.length > 0 &&
    mailboxes.every((m) => m.password) &&
    postal &&
    beat.installed &&
    (claim_url === null || claim_secret);
  return {
    ready,
    settings: cfg !== null,
    values: senderValues(home),
    mailboxes,
    postal,
    claim_url,
    claim_secret,
    last_pass_at: beat.last_pass_at,
    running: beat.installed,
    fix,
  };
}

export function connectionsOf(home: string, repoRoot: string, now: Date = new Date()) {
  const outcomes_secret = credSaved(home, OUTCOMES);
  const frequency = {
    ready: outcomes_secret,
    site: process.env.FW_FREQUENCY_URL || null,
    outcomes_secret,
    fix: outcomes_secret ? [] : [saveCred(home, OUTCOMES)],
  };

  let g: ReturnType<typeof ga4Of> = null;
  try {
    const ads = loadAds(repoRoot, home);
    g = ads ? ga4Of(ads.cfg) : null;
  } catch {
    g = null;
  }
  const key = g ? credSaved(home, g.credential) : false;
  const ga4 = {
    ready: g !== null && key,
    property_id: g?.property_id ?? null,
    credential: g?.credential ?? null,
    key,
    last_pull: readPullStatus(home),
    fix: !g
      ? ['Add a ga4 block with property_id and credential to flows/paid-ads/config.json']
      : key
        ? []
        : [`install -m 600 ~/Downloads/your-key.json ${join(home, 'creds', g.credential)}`],
  };
  return { email: emailOf(home, now), frequency, ga4 };
}

// FW-C-095: the sender's settings from Settings. Checked the way senders/email.mjs checks them; the file keeps
// every other key (routes, claim, smtp_url). Passwords never come this way: they stay in the keychain.
const ADDRESS = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/;
const BOX_KEY = /^[a-z][a-z0-9_]{0,19}$/;
const SECRET_FIELD = /password|secret|token|^pass$/i;

export interface SenderValues {
  mailboxes: { key: string; address: string; name: string }[];
  postal: string;
  daily_cap: number;
  per_pass: number;
  hours: { start: number; end: number; days: number[] };
}

const whole = (v: unknown, lo: number, hi: number) =>
  Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

/** The checked settings, or the reason they are refused. */
export function checkSender(b: unknown): { values: SenderValues } | { error: string } {
  const o = b && typeof b === 'object' ? (b as Record<string, unknown>) : {};
  const boxes = Array.isArray(o.mailboxes) ? o.mailboxes : [];
  if (Object.keys(o).some((k) => SECRET_FIELD.test(k)))
    return { error: 'Passwords stay in the keychain, not here.' };
  if (boxes.length < 1 || boxes.length > 3) return { error: 'Give one to three mailboxes.' };
  const mailboxes: SenderValues['mailboxes'] = [];
  for (const m of boxes) {
    const x = m && typeof m === 'object' ? (m as Record<string, unknown>) : {};
    if (Object.keys(x).some((k) => SECRET_FIELD.test(k)))
      return { error: 'Passwords stay in the keychain, not here.' };
    const key = typeof x.key === 'string' ? x.key : '';
    const address = typeof x.address === 'string' ? x.address.trim() : '';
    const name = typeof x.name === 'string' ? x.name.trim().slice(0, 100) : '';
    if (!BOX_KEY.test(key))
      return { error: `Mailbox key ${JSON.stringify(key)} must be lowercase letters, digits or _.` };
    if (mailboxes.some((y) => y.key === key)) return { error: `Mailbox ${key} is listed twice.` };
    if (!ADDRESS.test(address)) return { error: `${address || 'A mailbox'} is not an email address.` };
    mailboxes.push({ key, address, name });
  }
  const postal = typeof o.postal === 'string' ? o.postal.trim() : '';
  if (!postal || postal.length > 300)
    return { error: 'A postal address (at most 300 characters) is required.' };
  if (!whole(o.daily_cap, 1, 40)) return { error: 'Daily cap is a whole number from 1 to 40.' };
  if (!whole(o.per_pass, 1, 5)) return { error: 'Per pass is a whole number from 1 to 5.' };
  const h = o.hours && typeof o.hours === 'object' ? (o.hours as Record<string, unknown>) : {};
  if (!whole(h.start, 0, 23) || !whole(h.end, 1, 24) || (h.end as number) <= (h.start as number))
    return { error: 'Sending hours need a start from 0 to 23 and a later end up to 24.' };
  const days = Array.isArray(h.days) ? h.days : [];
  if (days.length === 0 || !days.every((d) => whole(d, 0, 6)))
    return { error: 'Pick at least one day (0 is Sunday).' };
  return {
    values: {
      mailboxes,
      postal,
      daily_cap: o.daily_cap as number,
      per_pass: o.per_pass as number,
      hours: {
        start: h.start as number,
        end: h.end as number,
        days: [...new Set(days as number[])].sort((a, b) => a - b),
      },
    },
  };
}

/** Writes the checked settings into $FW_HOME/senders/email.json (0600), keeping every other key. */
export function saveSender(home: string, v: SenderValues): void {
  const file = join(home, 'senders', 'email.json');
  let old: Record<string, unknown> = {};
  try {
    const c = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (c && typeof c === 'object' && !Array.isArray(c)) old = c as Record<string, unknown>;
  } catch {
    old = {};
  }
  const mailboxes = Object.fromEntries(
    v.mailboxes.map((m) => [m.key, m.name ? { address: m.address, name: m.name } : { address: m.address }]),
  );
  const oldRoutes =
    old.routes && typeof old.routes === 'object' ? (old.routes as Record<string, unknown>) : {};
  const routes = Object.fromEntries(
    Object.entries(oldRoutes).filter(([, k]) => typeof k === 'string' && k in mailboxes),
  );
  if (!('frequency' in routes)) routes.frequency = v.mailboxes[0]?.key;
  const next = {
    ...old,
    mailboxes,
    routes,
    postal: v.postal,
    daily_cap: v.daily_cap,
    per_pass: v.per_pass,
    hours: v.hours,
  };
  mkdirSync(join(home, 'senders'), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

/** What Settings fills its form with, or null when the sender has no settings file. */
export function senderValues(home: string): SenderValues | null {
  try {
    const c = JSON.parse(readFileSync(join(home, 'senders', 'email.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const boxes = (c.mailboxes && typeof c.mailboxes === 'object' ? c.mailboxes : {}) as Record<
      string,
      Record<string, unknown>
    >;
    const h = (c.hours ?? {}) as Record<string, unknown>;
    return {
      mailboxes: Object.entries(boxes).map(([key, m]) => ({
        key,
        address: typeof m?.address === 'string' ? m.address : '',
        name: typeof m?.name === 'string' ? m.name : '',
      })),
      postal: typeof c.postal === 'string' ? c.postal : '',
      daily_cap: typeof c.daily_cap === 'number' ? c.daily_cap : 15,
      per_pass: typeof c.per_pass === 'number' ? c.per_pass : 1,
      hours: {
        start: typeof h.start === 'number' ? h.start : 9,
        end: typeof h.end === 'number' ? h.end : 17,
        days: Array.isArray(h.days) ? (h.days as number[]) : [1, 2, 3, 4, 5],
      },
    };
  } catch {
    return null;
  }
}
