// $FW_HOME resolution and the small config the ledger reads from it.
//   FW_HOME              default ~/.flowweb
//   $FW_HOME/db/fw.sqlite  the database
//   $FW_HOME/config.json   optional: { "project": { "slug", "name", "repo_url" } }
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ProjectConfig } from './bootstrap.ts';
import { LedgerError } from './errors.ts';

export function resolveHome(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(explicit ?? env.FW_HOME ?? join(homedir(), '.flowweb'));
}

export function dbPath(home: string): string {
  return join(home, 'db', 'fw.sqlite');
}

export interface HomeConfig {
  project?: { slug?: string; name?: string; repo_url?: string };
}

export function loadHomeConfig(home: string): HomeConfig {
  const path = join(home, 'config.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as HomeConfig;
  } catch (e) {
    throw new LedgerError('BAD_ARGUMENT', `${path} is not valid JSON: ${(e as Error).message}`);
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63) || 'project'
  );
}

/** Project for sync: flags first, then $FW_HOME/config.json, then the repo directory's name. */
export function resolveProject(
  home: string,
  repoDir: string,
  overrides: { slug?: string; name?: string } = {},
): ProjectConfig {
  const cfg = loadHomeConfig(home).project ?? {};
  const slug = overrides.slug ?? cfg.slug ?? slugify(basename(resolve(repoDir)));
  if (!SLUG_RE.test(slug))
    throw new LedgerError('BAD_ARGUMENT', `project slug must match ${SLUG_RE}: ${slug}`);
  return {
    slug,
    name: overrides.name ?? cfg.name ?? slug,
    repo_url: cfg.repo_url ?? pathToFileURL(resolve(repoDir)).href,
  };
}
