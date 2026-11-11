// The Owner's agent teams (FW-C-123): one 'main' team, whose CEO is the owner's primary agent
// (Kevin by default), plus one team per project brand with that business's own CEO. The roster is
// fixed code (roles.ts); settings('team') keeps only the Owner's renames and voices, per team.
// A member is working while one of its flows is on, a chief while one of its managers is, the CEO
// and COO always; everyone else is on the bench until their department opens.
import type { ActorKind, Reader, Writer } from '@fw/eventlog';
import { ownerActor } from '@fw/ledger';
import { CEO_PRESETS, PERSONAL, ROLES, type Role } from './roles.ts';

export { ROLES } from './roles.ts';
export const TEAM_SETTINGS_KEY = 'team';
export const MAX_NAME = 40;
export const MAX_VOICE = 200;

type Override = { name?: string; voice?: string };
export interface TeamSettings {
  version: 1;
  teams: Record<string, Record<string, Override>>;
}

export interface Member extends Role {
  default_name: string;
  default_voice: string | null;
  status: 'working' | 'bench';
}
export interface Team {
  key: string;
  brand: string | null;
  label: string;
  members: Member[];
}

export class TeamError extends Error {
  readonly code: 'NOT_FOUND' | 'INVALID';
  constructor(code: 'NOT_FOUND' | 'INVALID', message: string) {
    super(message);
    this.code = code;
  }
}

const parse = (v: unknown): Record<string, unknown> | null => {
  if (typeof v !== 'string') return null;
  try {
    const o = JSON.parse(v);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
};
const setting = (r: Reader, key: string) =>
  parse(r.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])?.value);

export function readTeamSettings(r: Reader): TeamSettings {
  const teams: TeamSettings['teams'] = {};
  const raw = (setting(r, TEAM_SETTINGS_KEY)?.teams ?? {}) as Record<string, Record<string, unknown>>;
  for (const [t, members] of Object.entries(raw)) {
    if (!members || typeof members !== 'object') continue;
    for (const [id, o] of Object.entries(members)) {
      const v = (o ?? {}) as Record<string, unknown>;
      const out: Override = {};
      if (typeof v.name === 'string') out.name = v.name;
      if (typeof v.voice === 'string') out.voice = v.voice;
      if (out.name === undefined && out.voice === undefined) continue;
      teams[t] = { ...(teams[t] ?? {}), [id]: out };
    }
  }
  return { version: 1, teams };
}

/** The distinct project brands, in the case first seen, sorted. */
export function brandsOf(r: Reader): string[] {
  const labels = setting(r, 'project_labels') ?? {};
  const seen = new Map<string, string>();
  for (const v of Object.values(labels)) {
    const b = (v as { brand?: unknown })?.brand;
    if (typeof b === 'string' && b.trim()) {
      const k = teamKeyOf(b);
      if (k && k !== 'main' && !seen.has(k)) seen.set(k, b.trim());
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** Flows turned on and not archived; a copy (base--slug) counts as its base flow. */
export function enabledFlowsOf(r: Reader): string[] {
  const flows = (setting(r, 'supervisor')?.flows ?? {}) as Record<
    string,
    { enabled?: unknown; archived?: unknown }
  >;
  const on = new Set<string>();
  for (const [k, v] of Object.entries(flows))
    if (v?.enabled === true && v?.archived !== true) on.add(k.split('--')[0] as string);
  return [...on];
}

export const teamKeyOf = (brand: string) =>
  brand
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

function statuses(enabled: Set<string>): Map<string, 'working' | 'bench'> {
  const out = new Map<string, 'working' | 'bench'>();
  for (const r of ROLES) out.set(r.id, r.flows.some((f) => enabled.has(f)) ? 'working' : 'bench');
  out.set('ceo', 'working');
  out.set('coo', 'working');
  const anyOn = enabled.size > 0;
  for (const r of ROLES) {
    if (r.level === 'staff' || r.level === 'building')
      out.set(r.id, anyOn || r.level === 'building' ? 'working' : 'bench');
    if (r.level === 'exec' && r.id !== 'coo')
      out.set(
        r.id,
        ROLES.some((m) => m.reports_to === r.id && m.level === 'manager' && out.get(m.id) === 'working')
          ? 'working'
          : 'bench',
      );
  }
  return out;
}

export function teamView(
  settings: Partial<TeamSettings>,
  brands: string[],
  enabledFlows: string[] = [],
): { teams: Team[] } {
  const status = statuses(new Set(enabledFlows));
  const make = (key: string, brand: string | null): Team => {
    const over = settings.teams?.[key] ?? {};
    const members = ROLES.map((r): Member => {
      const base: Role = r.level === 'ceo' && brand ? { ...r, ...CEO_PRESETS[key] } : r;
      const o = over[r.id] ?? {};
      return {
        ...base,
        flows: [...base.flows],
        name: o.name ?? base.name,
        voice: o.voice ?? base.voice,
        default_name: base.name,
        default_voice: base.voice,
        status: status.get(r.id) ?? 'bench',
      };
    });
    return { key, brand, label: brand ?? 'Your team', members };
  };
  return { teams: [make('main', null), ...brands.map((b) => make(teamKeyOf(b), b))] };
}

/** The Owner renames an agent or changes its voice: a string sets it, null restores the default. */
export function setTeamMember(w: Writer, team: string, role: string, body: Record<string, unknown>) {
  const keys = new Set(['main', ...brandsOf(w).map(teamKeyOf)]);
  if (!keys.has(team)) throw new TeamError('NOT_FOUND', `no team named ${team}`);
  if (!ROLES.some((r) => r.id === role)) throw new TeamError('NOT_FOUND', `no agent named ${role}`);
  if (!PERSONAL.has(role))
    throw new TeamError('INVALID', `${role} is part of the building and has no name to change`);
  const change: { name?: string | null; voice?: string | null } = {};
  for (const [f, max] of [
    ['name', MAX_NAME],
    ['voice', MAX_VOICE],
  ] as const) {
    if (!(f in body)) continue;
    const v = body[f];
    if (v === null) change[f] = null;
    else if (typeof v === 'string' && v.trim() && v.trim().length <= max) change[f] = v.trim();
    else throw new TeamError('INVALID', `${f} must be text of 1 to ${max} characters, or null`);
  }
  if (!Object.keys(change).length) throw new TeamError('INVALID', 'send name or voice');

  return w.transaction((tx) => {
    const s = readTeamSettings(tx);
    const cur = { ...(s.teams[team]?.[role] ?? {}) };
    for (const [f, v] of Object.entries(change) as ['name' | 'voice', string | null][]) {
      if (v === null) delete cur[f];
      else cur[f] = v;
    }
    const before = JSON.stringify(s.teams[team]?.[role] ?? {});
    if (JSON.stringify(cur) === before) return { changed: false };
    s.teams[team] = s.teams[team] ?? {};
    const t = s.teams[team];
    if (cur.name === undefined && cur.voice === undefined) delete t[role];
    else t[role] = cur;
    let by: { kind: ActorKind; id: string };
    try {
      by = ownerActor(tx);
    } catch {
      by = { kind: 'system', id: 'fwd' };
    }
    tx.run(
      `INSERT INTO settings(key, value, trust_tier, description, updated_by) VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = version + 1,
         updated_by = excluded.updated_by,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      [TEAM_SETTINGS_KEY, JSON.stringify(s), "The Owner's names and voices for their agent teams", by.id],
    );
    const version = tx.get<{ version: number }>('SELECT version FROM settings WHERE key = ?', [
      TEAM_SETTINGS_KEY,
    ])!.version;
    tx.appendEvent({
      type: 'system.config_changed',
      actor_kind: by.kind,
      actor_id: by.id,
      idempotency_key: `${TEAM_SETTINGS_KEY}:${version}`,
      payload: { setting: TEAM_SETTINGS_KEY, version, team, role, ...change },
    });
    return { changed: true };
  });
}
