// FW-C-094: is email sending, the Frequency link and Google Analytics set up on this machine? Read from
// FW_HOME, the repo's paid-ads config, fwd's env and the keychain. A secret is only checked for presence:
// the keychain is asked without -w and its output is discarded, and a creds file is only stat'ed, so no
// secret value is ever read into this answer. FW_KEYCHAIN=off leaves the keychain out (tests).
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
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
