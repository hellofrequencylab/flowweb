// FW-C-152: profile flows. A profile is a shipped preset for a copy of a flow (FW-C-121): who the copy
// hunts for, how its notes read, which Frequency page its links open, and the hunts it starts with. The
// files live in flows/<base>/profiles/<slug>.json. This module also holds what flows that run side by side
// must share: one do-not-contact list and one record of who was already written to.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Row = Record<string, unknown>;
const isObj = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface Profile {
  slug: string;
  name: string;
  note: string;
  /** A patch over the base flow's config; object values merge one level deep, everything else replaces. */
  config: Row;
  /** Bodies for newHunt: the hunts the copy starts with. */
  hunts: Row[];
}

const profilesDir = (repoRoot: string, base: string) => join(repoRoot, 'flows', base, 'profiles');

/** The profile a flow ships under this slug, or null. A malformed file reads as no profile. */
export function loadProfile(repoRoot: string, base: string, slug: string): Profile | null {
  if (!SLUG.test(slug)) return null;
  const p = join(profilesDir(repoRoot, base), `${slug}.json`);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    if (!isObj(raw) || raw.slug !== slug || typeof raw.name !== 'string' || !isObj(raw.config)) return null;
    return {
      slug,
      name: raw.name,
      note: typeof raw.note === 'string' ? raw.note : '',
      config: raw.config,
      hunts: Array.isArray(raw.hunts) ? raw.hunts.filter(isObj) : [],
    };
  } catch {
    return null;
  }
}

/** Every profile a flow ships, by slug. */
export function listProfiles(repoRoot: string, base: string): Profile[] {
  const dir = profilesDir(repoRoot, base);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .flatMap((f) => loadProfile(repoRoot, base, f.slice(0, -5)) ?? []);
}

/** The profile's patch laid over a config: objects merge one level deep, arrays and plain values replace. */
export function mergeProfile(cfg: Row, patch: Row): Row {
  const out: Row = { ...cfg };
  for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(cfg[k]) ? { ...cfg[k], ...v } : v;
  return out;
}

/** The lines of a profile's hunt playbook, in the order the brief gives them. */
export const PLAYBOOK_KEYS = [
  'seek',
  'signals',
  'where',
  'queries',
  'skip',
  'rank',
  'record',
  'note',
] as const;
export type Playbook = Partial<Record<(typeof PLAYBOOK_KEYS)[number], string>>;
const LINE_MAX = 1200;

/** The hunt playbook in the cycle folder's config.json (hunts.playbook), or null when it has none. */
export function playbookOf(dir: string): Playbook | null {
  try {
    const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as {
      hunts?: { playbook?: unknown };
    };
    const raw = cfg.hunts?.playbook;
    if (!isObj(raw)) return null;
    const out: Playbook = {};
    for (const k of PLAYBOOK_KEYS) {
      const v = raw[k];
      if (typeof v === 'string' && v.trim() !== '') out[k] = v.trim().slice(0, LINE_MAX);
    }
    return out.seek && out.note ? out : null;
  } catch {
    return null;
  }
}

export interface SharedReach {
  /** Every address, domain or page on any of the flow's do-not-contact lists. */
  doNotContact: string[];
  /** Every contact key (address or contact page) the base flow or one of its copies has drafted for. */
  contacted: Set<string>;
}

/**
 * What the base flow and every copy of it know about who not to write to: the do-not-contact lists and the
 * hunt contacts of $FW_HOME/flows/<base>/state.json and each $FW_HOME/copies/<key>/flows/<base>/state.json.
 * An opt-out given to one flow holds for all of them, and nobody hears from two.
 */
export function sharedReach(rootHome: string, base: string): SharedReach {
  const files = [join(rootHome, 'flows', base, 'state.json')];
  const copies = join(rootHome, 'copies');
  if (existsSync(copies))
    for (const key of readdirSync(copies))
      if (key.startsWith(`${base}--`)) files.push(join(copies, key, 'flows', base, 'state.json'));
  const dnc = new Set<string>();
  const contacted = new Set<string>();
  for (const f of files) {
    if (!existsSync(f)) continue;
    try {
      const s = JSON.parse(readFileSync(f, 'utf8')) as { do_not_contact?: unknown; hunt_contacts?: unknown };
      if (Array.isArray(s.do_not_contact)) for (const x of s.do_not_contact) dnc.add(String(x));
      if (isObj(s.hunt_contacts)) for (const k of Object.keys(s.hunt_contacts)) contacted.add(k);
    } catch {}
  }
  return { doNotContact: [...dnc], contacted };
}
