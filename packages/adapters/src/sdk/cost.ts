// Cost accounting. A vendor-reported dollar figure wins; without one the adapter estimates from
// token counts and marks the record estimated. Either counts against the caps.
import type { CostRecord } from './types.ts';

/** Dollars per million tokens. Estimates only; the daemon may pass its own table. */
export interface Pricing {
  input_per_mtok: number;
  output_per_mtok: number;
  cached_per_mtok: number;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
}

export const ZERO_USAGE: TokenUsage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0 };

export function estimateUsd(u: TokenUsage, p: Pricing): number {
  const usd =
    (u.input_tokens * p.input_per_mtok +
      u.output_tokens * p.output_per_mtok +
      u.cached_tokens * p.cached_per_mtok) /
    1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cached_tokens: a.cached_tokens + b.cached_tokens,
  };
}

export function costRecord(u: TokenUsage, reportedUsd: number | undefined, p: Pricing): CostRecord {
  const reported = typeof reportedUsd === 'number' && Number.isFinite(reportedUsd) && reportedUsd >= 0;
  return {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cached_tokens: u.cached_tokens,
    usd: reported ? reportedUsd : estimateUsd(u, p),
    estimated: !reported,
  };
}

/** Non-negative integer from an untrusted value, else 0. */
export function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}
