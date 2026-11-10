// Paid ads flow (FW-C-048): a read-only view of one ad campaign for GET /v1/flows/paid-ads.
// It reads the campaign's daily numbers from report CSVs the Owner drops into
// $FW_HOME/flows/paid-ads/imports/, adds them up, and names one next move. It never changes the
// campaign: it holds no ad account credential and its stream has no outward action class.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FLOW_KEY = 'paid-ads';

export interface AdsConfig {
  version: number;
  campaign: { name: string; platform: string; goal: string; landing_url?: string };
  source: { kind: string; how: string };
  target_cost_per_subscription_usd: number;
  target_is_placeholder?: boolean;
  learning_days: number;
  check_tracking_multiple: number;
}

/** One day of one campaign, as the report states it. */
export interface AdsDay {
  date: string;
  impressions: number;
  clicks: number;
  spend_usd: number;
  subscriptions: number;
}

export interface AdsFigures {
  days: number;
  spend_usd: number;
  impressions: number;
  clicks: number;
  subscriptions: number;
  /** Clicks over impressions, null with no impressions. */
  ctr: number | null;
  cost_per_click_usd: number | null;
  cost_per_subscription_usd: number | null;
}

export type NextMove =
  | { kind: 'waiting_for_data'; why: string }
  | { kind: 'learning'; why: string; days_left: number }
  | { kind: 'check_tracking'; why: string }
  | { kind: 'over_target'; why: string }
  | { kind: 'on_target'; why: string };

const round2 = (n: number) => Math.round(n * 100) / 100;

/** "1,234.50", "$12", "--" and "" all become numbers (the last two zero). */
function num(raw: string | undefined): number {
  const n = Number((raw ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** Splits one CSV line, honouring double quotes and doubled quotes inside them. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === '\t') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const HEADERS: Record<keyof Omit<AdsDay, 'date'> | 'date' | 'campaign', string[]> = {
  date: ['day', 'date'],
  campaign: ['campaign'],
  impressions: ['impr.', 'impressions', 'impr'],
  clicks: ['clicks'],
  spend_usd: ['cost', 'spend', 'amount spent'],
  subscriptions: ['conversions', 'conv.', 'all conv.'],
};

type ColKey = keyof typeof HEADERS;
const COLS = Object.keys(HEADERS) as ColKey[];

/**
 * Rows of one campaign from a Google Ads report export. Title lines before the header row are
 * skipped; total rows and rows for other campaigns are dropped. A file with no header row gives none.
 */
export function parseReport(text: string, campaign: string): AdsDay[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const want = campaign.trim().toLowerCase();
  let col: Record<ColKey, number> | null = null;
  const out: AdsDay[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = splitCsvLine(line);
    if (!col) {
      const lower = cells.map((c) => c.toLowerCase());
      const at = (k: keyof typeof HEADERS) => lower.findIndex((c) => HEADERS[k].includes(c));
      if (at('date') >= 0 && at('clicks') >= 0 && at('spend_usd') >= 0) {
        col = Object.fromEntries(COLS.map((k) => [k, at(k)])) as Record<ColKey, number>;
      }
      continue;
    }
    const date = cells[col.date] ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (col.campaign >= 0 && (cells[col.campaign] ?? '').trim().toLowerCase() !== want) continue;
    const c = col;
    const pick = (k: ColKey) => (c[k] >= 0 ? num(cells[c[k]]) : 0);
    out.push({
      date,
      impressions: pick('impressions'),
      clicks: pick('clicks'),
      spend_usd: pick('spend_usd'),
      subscriptions: pick('subscriptions'),
    });
  }
  return out;
}

/** Every CSV in imports/, oldest file first, so a newer file's numbers win for the same day. */
export function readImports(dir: string, campaign: string): AdsDay[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(csv|tsv)$/i.test(e.name))
    .map((e) => join(dir, e.name))
    .sort((a, b) => a.localeCompare(b));
  const byDay = new Map<string, AdsDay>();
  for (const f of files) {
    let text = '';
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const d of parseReport(text, campaign)) byDay.set(d.date, d);
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function figures(days: AdsDay[]): AdsFigures {
  const sum = (k: keyof Omit<AdsDay, 'date'>) => days.reduce((n, d) => n + d[k], 0);
  const spend = sum('spend_usd');
  const impressions = sum('impressions');
  const clicks = sum('clicks');
  const subs = sum('subscriptions');
  return {
    days: days.length,
    spend_usd: round2(spend),
    impressions,
    clicks,
    subscriptions: round2(subs),
    ctr: impressions > 0 ? clicks / impressions : null,
    cost_per_click_usd: clicks > 0 ? round2(spend / clicks) : null,
    cost_per_subscription_usd: subs > 0 ? round2(spend / subs) : null,
  };
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** One next move, from the whole campaign so far. Pure. */
export function nextMove(cfg: AdsConfig, t: AdsFigures): NextMove {
  const target = cfg.target_cost_per_subscription_usd;
  if (t.days === 0) return { kind: 'waiting_for_data', why: 'No campaign report has been imported yet.' };
  if (t.subscriptions === 0 && t.spend_usd >= target * cfg.check_tracking_multiple)
    return {
      kind: 'check_tracking',
      why: `${usd(t.spend_usd)} spent and no subscription recorded. Check that the purchase conversion is imported and primary before spending more.`,
    };
  if (t.days < cfg.learning_days)
    return {
      kind: 'learning',
      why: `${t.days} of ${cfg.learning_days} days of data. Google is still learning; hold changes until then.`,
      days_left: cfg.learning_days - t.days,
    };
  const cps = t.cost_per_subscription_usd;
  if (cps === null || cps > target)
    return {
      kind: 'over_target',
      why: `Each subscription costs ${cps === null ? 'more than the spend so far' : usd(cps)}, above the ${usd(target)} target. Your call: tighten keywords or the area, lower the budget, or raise the target.`,
    };
  return {
    kind: 'on_target',
    why: `Each subscription costs ${usd(cps)}, within the ${usd(target)} target.`,
  };
}

export function flowView(cfg: AdsConfig, stream: Record<string, unknown>, days: AdsDay[], now: Date) {
  const totals = figures(days);
  const cutoff = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
  return {
    key: FLOW_KEY,
    name: typeof stream.name === 'string' ? stream.name : 'Paid ads',
    enabled: stream.enabled === true,
    campaign: cfg.campaign,
    source: cfg.source,
    target_cost_per_subscription_usd: cfg.target_cost_per_subscription_usd,
    target_is_placeholder: cfg.target_is_placeholder === true,
    learning_days: cfg.learning_days,
    first_day: days[0]?.date ?? null,
    last_day: days.at(-1)?.date ?? null,
    totals,
    last_7_days: figures(days.filter((d) => d.date >= cutoff)),
    next_move: nextMove(cfg, totals),
  };
}

export function loadFlow(repoRoot: string, fwHome: string) {
  const repoDir = join(repoRoot, 'flows', FLOW_KEY);
  const homeDir = join(fwHome, 'flows', FLOW_KEY);
  if (!existsSync(join(repoDir, 'stream.json'))) return null;
  const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8')) as unknown;
  const cfgPath = existsSync(join(homeDir, 'config.json'))
    ? join(homeDir, 'config.json')
    : join(repoDir, 'config.json');
  const stream = readJson(join(repoDir, 'stream.json')) as Record<string, unknown>;
  const cfg = readJson(cfgPath) as AdsConfig;
  return { stream, cfg, days: readImports(join(homeDir, 'imports'), cfg.campaign.name) };
}
