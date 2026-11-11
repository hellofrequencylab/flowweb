// FW-C-121: more than one copy of a flow. A copy is a flow key "<base>--<slug>" that the Supervisor settings
// list with copy_of = base. Its engine, prompts and stream are the base flow's; its home is
// $FW_HOME/copies/<key>/, so every module that keeps state under <home>/flows/<base>/ (leads, drafts, hunts,
// spend, config override) keeps the copy's apart without knowing copies exist.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const COPY_SEP = '--';
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** A copy's key becomes its stream key, which the stream contract caps at 41 characters. */
export const COPY_KEY_MAX = 41;
/** Fixed templates or one shared queue: a second copy would only send the same thing twice. */
export const NOT_COPYABLE = new Set(['host-moments', 'local-pulse', 'email-queue']);

/** The flow a key runs (its base) and the home its state lives under. Pure: no file or database read. */
export function flowRef(fwHome: string, key: string): { base: string; home: string; copy: boolean } {
  const i = key.indexOf(COPY_SEP);
  if (i <= 0) return { base: key, home: fwHome, copy: false };
  return { base: key.slice(0, i), home: join(fwHome, 'copies', key), copy: true };
}

export function isCopyKey(key: string): boolean {
  return flowRef('', key).copy;
}

/** Checks a slug and the key it makes; returns the key or the reason it is refused. */
export function copyKey(base: string, slug: string): { key: string } | { error: string } {
  if (!SLUG_RE.test(slug)) return { error: 'slug must be lowercase letters and digits, with single dashes' };
  const key = `${base}${COPY_SEP}${slug}`;
  if (key.length > COPY_KEY_MAX) return { error: `a copy's key must be at most ${COPY_KEY_MAX} characters` };
  return { key };
}

/** The base flow's stream, renamed for the copy: its own key and a stream id derived from that key. */
export function copyStream(def: Record<string, unknown>, key: string): Record<string, unknown> {
  const id = `stm_c${createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
  return { ...def, id, key };
}

/**
 * The config a copy starts with: the base flow's effective config (the $FW_HOME override, else the repo's)
 * with the Owner's patch over it. Only top-level keys the base already has may change.
 */
export function copyConfig(
  repoRoot: string,
  fwHome: string,
  base: string,
  patch: unknown,
): { config: Record<string, unknown> } | { error: string } {
  const override = join(fwHome, 'flows', base, 'config.json');
  const file = existsSync(override) ? override : join(repoRoot, 'flows', base, 'config.json');
  let cfg: Record<string, unknown> = {};
  if (existsSync(file)) cfg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  if (patch === undefined || patch === null) return { config: cfg };
  if (typeof patch !== 'object' || Array.isArray(patch)) return { error: 'config must be an object' };
  for (const k of Object.keys(patch))
    if (!Object.hasOwn(cfg, k)) return { error: `config has no key ${k} in ${base}` };
  return { config: { ...cfg, ...(patch as Record<string, unknown>) } };
}

/** Writes the copy's config override, so its engine and cycles read it. */
export function writeCopyConfig(fwHome: string, key: string, config: Record<string, unknown>): void {
  const { base, home } = flowRef(fwHome, key);
  const dir = join(home, 'flows', base);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = join(dir, 'config.json');
  writeFileSync(`${p}.tmp`, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${p}.tmp`, p);
}
