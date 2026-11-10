// FW-C-058: fwd pulls the paid ads campaign's daily numbers from Google Analytics.
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { type AdsConfig, readImports } from '../src/flows/paid-ads.ts';
import {
  assertion,
  type Ga4Config,
  ga4Of,
  pullGa4,
  readPullStatus,
  rowsToCsv,
} from '../src/flows/paid-ads-ga4.ts';

const CAMPAIGN = 'Find your people locally';
const G: Ga4Config = {
  property_id: '539919559',
  credential: 'crd_testga4',
  pull_every_hours: 6,
  lookback_days: 90,
};
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = {
  client_email: 'fw@test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function home(withKey = true): string {
  const h = mkdtempSync(join(tmpdir(), 'fw-ga4-'));
  dirs.push(h);
  if (withKey) {
    mkdirSync(join(h, 'creds'), { mode: 0o700 });
    writeFileSync(join(h, 'creds', G.credential), JSON.stringify(KEY), { mode: 0o600 });
  }
  return h;
}

const row = (d: string, c: string, m: string[]) => ({
  dimensionValues: [{ value: d }, { value: c }],
  metricValues: m.map((value) => ({ value })),
});

function fakeFetch(
  report: unknown,
  seen: { url: string; body: string; auth?: string | undefined }[],
): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const body = String(init.body ?? '');
    seen.push({ url, body, auth: (init.headers as Record<string, string>).authorization });
    if (url.endsWith('/token'))
      return new Response(JSON.stringify({ access_token: 'tok123' }), { status: 200 });
    return new Response(JSON.stringify(report), { status: 200 });
  }) as typeof fetch;
}

describe('ga4Of', () => {
  test('is null without a property and credential, and fills defaults', () => {
    const base = { campaign: { name: CAMPAIGN } } as AdsConfig;
    expect(ga4Of(base)).toBeNull();
    expect(ga4Of({ ...base, ga4: { property_id: '1', credential: 'crd_abcd' } } as AdsConfig)).toEqual({
      property_id: '1',
      credential: 'crd_abcd',
      pull_every_hours: 6,
      lookback_days: 90,
    });
  });
});

describe('assertion', () => {
  test('is an RS256 JWT for the read-only Analytics scope that the public key verifies', () => {
    const jwt = assertion(
      KEY.client_email,
      KEY.private_key,
      'https://oauth2.googleapis.com/token',
      new Date(0),
    );
    const [h, b, s] = jwt.split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(b, 'base64url').toString());
    expect(claims).toMatchObject({
      iss: KEY.client_email,
      scope: 'https://www.googleapis.com/auth/analytics.readonly',
      iat: 0,
      exp: 3600,
    });
    expect(
      createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, Buffer.from(s, 'base64url')),
    ).toBe(true);
  });
});

describe('rowsToCsv', () => {
  test('turns GA4 rows into a report the CSV reader understands', () => {
    const { csv, days } = rowsToCsv([
      row('20261110', CAMPAIGN, ['1000', '20', '12.5', '1']),
      row('20261111', 'Other, campaign', ['5', '1', '1', '0']),
      row('bad', CAMPAIGN, ['1', '1', '1', '1']),
    ]);
    expect(days).toBe(2);
    expect(csv).toContain('2026-11-10,Find your people locally,1000,20,12.5,1');
    expect(csv).toContain('"Other, campaign"');
  });
});

describe('pullGa4', () => {
  test('signs in, asks for daily ad cost by campaign, and writes a report the flow reads', async () => {
    const h = home();
    const seen: { url: string; body: string; auth?: string | undefined }[] = [];
    const report = {
      rows: [
        row('20261110', CAMPAIGN, ['1000', '20', '12.5', '1']),
        row('20261111', CAMPAIGN, ['800', '10', '7.5', '0']),
      ],
    };
    const s = await pullGa4(G, h, {
      fetch: fakeFetch(report, seen),
      keychain: false,
      now: new Date('2026-11-12T00:00:00Z'),
    });
    expect(s).toEqual({ ok: true, at: '2026-11-12T00:00:00.000Z', days: 2 });
    expect(seen[0]?.body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
    expect(seen[1]?.url).toBe('https://analyticsdata.googleapis.com/v1beta/properties/539919559:runReport');
    expect(seen[1]?.auth).toBe('Bearer tok123');
    expect(JSON.parse(seen[1]?.body ?? '{}').metrics.map((m: { name: string }) => m.name)).toEqual([
      'advertiserAdImpressions',
      'advertiserAdClicks',
      'advertiserAdCost',
      'keyEvents:purchase',
    ]);
    const days = readImports(join(h, 'flows', 'paid-ads', 'imports'), CAMPAIGN);
    expect(days.map((d) => [d.date, d.spend_usd, d.subscriptions])).toEqual([
      ['2026-11-10', 12.5, 1],
      ['2026-11-11', 7.5, 0],
    ]);
    expect(readPullStatus(h)?.ok).toBe(true);
  });

  test('a missing key is a failed pull with the fix, not a crash, and never leaks the key', async () => {
    const h = home(false);
    const s = await pullGa4(G, h, { fetch: fakeFetch({}, []), keychain: false });
    expect(s.ok).toBe(false);
    expect(s.error).toContain(G.credential);
    expect(readPullStatus(h)?.ok).toBe(false);
  });

  test('a refused report says which property and why, and the key never appears', async () => {
    const h = home();
    const refuse = (async (url: string) =>
      url.endsWith('/token')
        ? new Response(JSON.stringify({ access_token: 't' }))
        : new Response(JSON.stringify({ error: { message: 'User does not have sufficient permissions' } }), {
            status: 403,
          })) as typeof fetch;
    const s = await pullGa4(G, h, { fetch: refuse, keychain: false });
    expect(s.error).toBe(
      'Google Analytics property 539919559 answered 403: User does not have sufficient permissions',
    );
    const status = readFileSync(join(h, 'flows', 'paid-ads', 'imports', '.ga4-status.json'), 'utf8');
    expect(status).not.toContain('PRIVATE KEY');
  });
});
