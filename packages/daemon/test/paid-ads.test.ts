// FW-C-048: the paid ads flow reads Google Ads report CSVs and names one next move.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  type AdsConfig,
  figures,
  nextMove,
  parseReport,
  readImports,
  splitCsvLine,
} from '../src/flows/paid-ads.ts';

const CAMPAIGN = 'Find your people locally';
const cfg: AdsConfig = {
  version: 1,
  campaign: { name: CAMPAIGN, platform: 'Google Ads', goal: 'subscriptions' },
  source: { kind: 'csv_import', how: '' },
  target_cost_per_subscription_usd: 30,
  learning_days: 14,
  check_tracking_multiple: 3,
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('parseReport', () => {
  test('skips title lines, reads quoted numbers with commas, and drops other campaigns and totals', () => {
    const csv = [
      'Campaign report',
      '"November 1, 2026 - November 2, 2026"',
      'Day,Campaign,Impr.,Clicks,Cost,Conversions',
      `2026-11-01,${CAMPAIGN},"1,200",30,"1,012.50",2.00`,
      '2026-11-01,Other,10,1,5.00,0',
      `2026-11-02,"${CAMPAIGN}",800,20,"$9.10",--`,
      'Total: Account,,"2,010",51,"1,026.60",2.00',
    ].join('\n');
    expect(parseReport(csv, CAMPAIGN)).toEqual([
      { date: '2026-11-01', impressions: 1200, clicks: 30, spend_usd: 1012.5, subscriptions: 2 },
      { date: '2026-11-02', impressions: 800, clicks: 20, spend_usd: 9.1, subscriptions: 0 },
    ]);
  });

  test('a file with no header row gives nothing', () => {
    expect(parseReport('just,some,text\n1,2,3', CAMPAIGN)).toEqual([]);
  });

  test('splitCsvLine keeps doubled quotes', () => {
    expect(splitCsvLine('a,"b ""c"", d",e')).toEqual(['a', 'b "c", d', 'e']);
  });
});

test('a later file replaces an earlier one for the same day', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ads-'));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  const head = 'Day,Campaign,Impr.,Clicks,Cost,Conversions';
  writeFileSync(join(dir, '2026-11-02.csv'), `${head}\n2026-11-01,${CAMPAIGN},100,5,4.00,0\n`);
  writeFileSync(
    join(dir, '2026-11-03.csv'),
    `${head}\n2026-11-01,${CAMPAIGN},120,6,4.50,1\n2026-11-02,${CAMPAIGN},90,3,2.00,0\n`,
  );
  const days = readImports(dir, CAMPAIGN);
  expect(days.map((d) => d.date)).toEqual(['2026-11-01', '2026-11-02']);
  expect(figures(days)).toMatchObject({
    spend_usd: 6.5,
    clicks: 9,
    subscriptions: 1,
    cost_per_subscription_usd: 6.5,
  });
});

describe('nextMove', () => {
  const t = (days: number, spend: number, subs: number) =>
    figures(
      Array.from({ length: days }, (_, i) => ({
        date: `2026-10-${String(i + 1).padStart(2, '0')}`,
        impressions: 100,
        clicks: 5,
        spend_usd: spend / days,
        subscriptions: i < subs ? 1 : 0,
      })),
    );
  test('no data waits', () => expect(nextMove(cfg, figures([])).kind).toBe('waiting_for_data'));
  test('early days learn', () => expect(nextMove(cfg, t(5, 40, 1)).kind).toBe('learning'));
  test('spend with no subscription asks to check tracking, even while learning', () =>
    expect(nextMove(cfg, t(5, 95, 0)).kind).toBe('check_tracking'));
  test('above target', () => expect(nextMove(cfg, t(20, 200, 2)).kind).toBe('over_target'));
  test('on target, the target itself included', () =>
    expect(nextMove(cfg, t(20, 300, 10)).kind).toBe('on_target'));
});
