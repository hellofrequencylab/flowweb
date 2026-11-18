// FW-C-156: what the Owner may edit about who a flow looks for and how its notes read, for the base flow
// and for each copy of it. The values live in the flow's own config.json (the copy's under
// $FW_HOME/copies/<key>/, the base flow's override under $FW_HOME/flows/<base>/), so the next cycle reads
// them with no restart. Only the playbook lines, the line before the link and the niche angles change here;
// regions, caps and the sign-off keep their own controls.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flowRef } from '../overseer/copies.ts';
import { AdminError, writeJsonAtomic } from './neighborhood-admin.ts';
import { PLAYBOOK_KEYS } from './profiles.ts';

type Row = Record<string, unknown>;
const isObj = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
const LINE_MAX = 1200;
const LINK_LINE_MAX = 200;
const ANGLE_MAX = 300;
const ANGLES_MAX = 8;
const ANGLE_KEY = /^[a-z0-9_]{1,40}$/;
/** House style for anything a draft may quote: no em or en dash. */
const DASH = /[–—]/;

/** One reason a niche might care, with the key the learning loop tags drafts by. */
export interface Angle {
  key: string;
  line: string;
}

export interface Targeting {
  key: string;
  /** False while the flow has no playbook: its hunts then follow the shipped event brief. */
  has_playbook: boolean;
  playbook: Record<(typeof PLAYBOOK_KEYS)[number], string>;
  link_line: string;
  /** The page a note's link opens. Read only here. */
  door: string | null;
  niches: { key: string; label: string; angles: Angle[]; door: string | null }[];
}

function configPath(repoRoot: string, fwHome: string, key: string): { read: string; write: string } {
  const { base, home } = flowRef(fwHome, key);
  const write = join(home, 'flows', base, 'config.json');
  return { read: existsSync(write) ? write : join(repoRoot, 'flows', base, 'config.json'), write };
}

function view(key: string, cfg: Row): Targeting {
  const hunts = isObj(cfg.hunts) ? cfg.hunts : {};
  const pb = isObj(hunts.playbook) ? hunts.playbook : {};
  const playbook = Object.fromEntries(
    PLAYBOOK_KEYS.map((k) => [k, typeof pb[k] === 'string' ? (pb[k] as string) : '']),
  ) as Targeting['playbook'];
  const host = isObj(cfg.funnels) && isObj(cfg.funnels.host) ? cfg.funnels.host : {};
  const niches = (Array.isArray(cfg.niches) ? cfg.niches : []).filter(isObj).map((n) => ({
    key: String(n.key ?? ''),
    label: String(n.label ?? n.key ?? ''),
    angles: (Array.isArray(n.angles) ? n.angles : []).filter(isObj).map((x) => ({
      key: String(x.key ?? ''),
      line: String(x.line ?? ''),
    })),
    door: typeof n.door === 'string' ? n.door : null,
  }));
  return {
    key,
    has_playbook: playbook.seek !== '' && playbook.note !== '',
    playbook,
    link_line: typeof hunts.link_line === 'string' ? hunts.link_line : '',
    door: typeof host.path === 'string' ? host.path : null,
    niches,
  };
}

/** The flow's targeting, or null when the flow ships no config. */
export function readTargeting(repoRoot: string, fwHome: string, key: string): Targeting | null {
  const p = configPath(repoRoot, fwHome, key).read;
  if (!existsSync(p)) return null;
  return view(key, JSON.parse(readFileSync(p, 'utf8')) as Row);
}

function line(v: unknown, name: string, max: number): string {
  if (typeof v !== 'string') throw new AdminError(400, `${name} must be text`);
  const t = v.trim();
  if (t.length > max) throw new AdminError(400, `${name} is at most ${max} characters`);
  if (DASH.test(t)) throw new AdminError(400, `${name} has an em or en dash; use a comma or a full stop`);
  return t;
}

/**
 * Saves the Owner's edit: { playbook?: { seek?, ... }, link_line?, niches?: { <key>: { angles: [{ key?, line }] } } }.
 * A field left out keeps its value. Returns the new targeting and a one-line summary for the admin log.
 */
export function saveTargeting(
  repoRoot: string,
  fwHome: string,
  key: string,
  body: Row,
): { targeting: Targeting; summary: string } {
  const paths = configPath(repoRoot, fwHome, key);
  if (!existsSync(paths.read)) throw new AdminError(404, `no flow named ${key}`);
  const cfg = JSON.parse(readFileSync(paths.read, 'utf8')) as Row;
  const hunts: Row = isObj(cfg.hunts) ? { ...cfg.hunts } : {};
  const changed: string[] = [];
  for (const k of Object.keys(body))
    if (!['playbook', 'link_line', 'niches'].includes(k))
      throw new AdminError(400, `${k} cannot be edited here`);

  if (body.playbook !== undefined) {
    if (!isObj(body.playbook)) throw new AdminError(400, 'playbook must be an object');
    const pb: Row = isObj(hunts.playbook) ? { ...hunts.playbook } : {};
    for (const [k, v] of Object.entries(body.playbook)) {
      if (!(PLAYBOOK_KEYS as readonly string[]).includes(k))
        throw new AdminError(400, `playbook has no line named ${k}`);
      const t = line(v, `playbook.${k}`, LINE_MAX);
      if (t === pb[k]) continue;
      if (t === '') delete pb[k];
      else pb[k] = t;
      changed.push(k);
    }
    const some = PLAYBOOK_KEYS.some((k) => typeof pb[k] === 'string');
    if (some && !(pb.seek && pb.note))
      throw new AdminError(
        400,
        'a playbook needs at least "seek" (who to look for) and "note" (how the note reads)',
      );
    if (some) hunts.playbook = pb;
    else delete hunts.playbook;
  }
  if (body.link_line !== undefined) {
    const t = line(body.link_line, 'link_line', LINK_LINE_MAX);
    if (t !== (hunts.link_line ?? '')) changed.push('link line');
    if (t === '') delete hunts.link_line;
    else hunts.link_line = t;
  }
  let niches = cfg.niches;
  if (body.niches !== undefined) {
    if (!isObj(body.niches)) throw new AdminError(400, 'niches must be an object keyed by niche id');
    const list = (Array.isArray(cfg.niches) ? cfg.niches : []).filter(isObj);
    for (const [id, edit] of Object.entries(body.niches)) {
      const at = list.findIndex((n) => n.key === id);
      if (at < 0) throw new AdminError(400, `no niche named ${id}`);
      if (!isObj(edit) || !Array.isArray(edit.angles))
        throw new AdminError(400, `niches.${id}.angles must be a list`);
      const angles: Angle[] = [];
      for (const [i, raw] of edit.angles.entries()) {
        const item: Row = isObj(raw) ? raw : { line: raw };
        const text = line(item.line, `niches.${id}.angles[${i}].line`, ANGLE_MAX);
        if (text === '') continue;
        const given = typeof item.key === 'string' && ANGLE_KEY.test(item.key) ? item.key : '';
        let key = given;
        for (let n = angles.length + 1; key === '' || angles.some((x) => x.key === key); n++)
          key = `angle_${n}`;
        angles.push({ key, line: text });
      }
      if (angles.length < 1 || angles.length > ANGLES_MAX)
        throw new AdminError(400, `niches.${id} needs 1 to ${ANGLES_MAX} angles`);
      if (JSON.stringify(angles) !== JSON.stringify(list[at]?.angles)) changed.push(`${id} angles`);
      list[at] = { ...list[at], angles };
    }
    niches = list;
  }
  const next: Row = { ...cfg, hunts, ...(niches === undefined ? {} : { niches }) };
  if (changed.length) writeJsonAtomic(paths.write, next);
  return {
    targeting: view(key, next),
    summary: changed.length ? `Edited ${key}: ${changed.join(', ')}.` : `Nothing changed in ${key}.`,
  };
}
