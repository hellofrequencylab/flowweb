// Paid ads, automatic pull (FW-C-058): fwd fetches the campaign's daily numbers from the Google
// Analytics property that Google Ads is linked to, and writes them as one more report file in
// imports/, so the paid-ads view reads them exactly as it reads a CSV the Owner drops in. It reads
// only: the service account is a GA4 Viewer, and the scope is analytics.readonly. The key lives behind
// a credential handle (keychain or $FW_HOME/creds/<handle>) and never reaches a log, an event or a file.
import { createSign } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCredential } from '../creds/index.ts';
import { type AdsConfig, FLOW_KEY } from './paid-ads.ts';

export interface Ga4Config {
  property_id: string;
  credential: string;
  pull_every_hours: number;
  /** How far back each pull reaches, in days. */
  lookback_days: number;
}

export interface PullStatus {
  ok: boolean;
  at: string;
  days?: number;
  error?: string;
}

export const PULL_FILE = 'ga4.csv';
const STATUS_FILE = '.ga4-status.json';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

export interface PullDeps {
  fetch?: typeof fetch;
  now?: Date;
  /** Test seams: point the token exchange and the Data API at a local fake. */
  tokenUrl?: string;
  apiBase?: string;
  /** Default true. Tests use only the file backend. */
  keychain?: boolean;
}

export function ga4Of(cfg: AdsConfig): Ga4Config | null {
  const g = (cfg as AdsConfig & { ga4?: Partial<Ga4Config> }).ga4;
  if (!g || typeof g.property_id !== 'string' || typeof g.credential !== 'string') return null;
  return {
    property_id: g.property_id,
    credential: g.credential,
    pull_every_hours:
      typeof g.pull_every_hours === 'number' && g.pull_every_hours > 0 ? g.pull_every_hours : 6,
    lookback_days: typeof g.lookback_days === 'number' && g.lookback_days > 0 ? g.lookback_days : 90,
  };
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

/** A signed service-account assertion (RFC 7523), RS256, valid for an hour. */
export function assertion(email: string, privateKey: string, aud: string, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: email, scope: SCOPE, aud, iat, exp: iat + 3600 }));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}

interface Ga4Row {
  dimensionValues?: { value?: string }[];
  metricValues?: { value?: string }[];
}

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** GA4 rows (date, campaign; impressions, clicks, cost, purchases) as a report CSV. */
export function rowsToCsv(rows: Ga4Row[]): { csv: string; days: number } {
  const lines = ['Day,Campaign,Impressions,Clicks,Cost,Conversions'];
  const days = new Set<string>();
  for (const r of rows) {
    const [d = '', campaign = ''] = (r.dimensionValues ?? []).map((v) => v.value ?? '');
    if (!/^\d{8}$/.test(d)) continue;
    const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    const m = (r.metricValues ?? []).map((v) => v.value ?? '0');
    days.add(date);
    lines.push([date, csvCell(campaign), ...m.slice(0, 4)].join(','));
  }
  return { csv: `${lines.join('\n')}\n`, days: days.size };
}

function importsDir(fwHome: string): string {
  return join(fwHome, 'flows', FLOW_KEY, 'imports');
}

export function readPullStatus(fwHome: string): PullStatus | null {
  try {
    return JSON.parse(readFileSync(join(importsDir(fwHome), STATUS_FILE), 'utf8')) as PullStatus;
  } catch {
    return null;
  }
}

function writeAtomic(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

/** One pull. Never throws: the outcome, success or the reason it failed, is the returned status. */
export async function pullGa4(g: Ga4Config, fwHome: string, deps: PullDeps = {}): Promise<PullStatus> {
  const now = deps.now ?? new Date();
  const doFetch = deps.fetch ?? fetch;
  const dir = importsDir(fwHome);
  mkdirSync(dir, { recursive: true });
  let status: PullStatus;
  try {
    const key = JSON.parse(
      resolveCredential(g.credential, { home: fwHome, keychain: deps.keychain ?? true }),
    ) as {
      client_email?: string;
      private_key?: string;
      token_uri?: string;
    };
    if (!key.client_email || !key.private_key)
      throw new Error(`credential ${g.credential} is not a service account key JSON`);
    const tokenUrl = deps.tokenUrl ?? key.token_uri ?? 'https://oauth2.googleapis.com/token';
    const tok = await doFetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: assertion(key.client_email, key.private_key, tokenUrl, now),
      }).toString(),
    });
    if (!tok.ok) throw new Error(`Google sign-in for ${key.client_email} answered ${tok.status}`);
    const accessToken = ((await tok.json()) as { access_token?: string }).access_token;
    if (!accessToken) throw new Error('Google sign-in returned no access token');
    const api = deps.apiBase ?? 'https://analyticsdata.googleapis.com';
    const rep = await doFetch(`${api}/v1beta/properties/${encodeURIComponent(g.property_id)}:runReport`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        dateRanges: [{ startDate: `${g.lookback_days}daysAgo`, endDate: 'today' }],
        dimensions: [{ name: 'date' }, { name: 'sessionGoogleAdsCampaignName' }],
        metrics: [
          { name: 'advertiserAdImpressions' },
          { name: 'advertiserAdClicks' },
          { name: 'advertiserAdCost' },
          { name: 'keyEvents:purchase' },
        ],
        limit: 10000,
      }),
    });
    if (!rep.ok) {
      const why = ((await rep.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message;
      throw new Error(
        `Google Analytics property ${g.property_id} answered ${rep.status}${why ? `: ${why}` : ''}`,
      );
    }
    const { csv, days } = rowsToCsv(((await rep.json()) as { rows?: Ga4Row[] }).rows ?? []);
    writeAtomic(join(dir, PULL_FILE), csv);
    status = { ok: true, at: now.toISOString(), days };
  } catch (e) {
    status = { ok: false, at: now.toISOString(), error: (e as Error).message };
  }
  writeAtomic(join(dir, STATUS_FILE), `${JSON.stringify(status)}\n`);
  return status;
}
