// FW-C-169: what the Owner sets for the site from Settings: which model Kevin (the console) answers with,
// his standing instructions, the page that opens first, and which optional panels the flow pages show.
// One file, $FW_HOME/site-settings.json, written only here; the relay mirrors the GET so the site can read
// it. A save names only what changes. Anything unknown is refused and nothing is written.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hasSecretShape } from '@fw/eventlog';
import { AdminError, writeJsonAtomic } from './flows/neighborhood-admin.ts';

type Row = Record<string, unknown>;
/** Kept in step with KEVIN_MODELS in hosted/server/assistant.mjs by the probe ui/site-settings. */
export const KEVIN_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', about: 'The most careful answers. The default.' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', about: 'Quicker and about half the cost per answer.' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', about: 'The fastest and cheapest, for short questions.' },
];
const HOMES = ['today', 'flows', 'drafts'];
/** The optional panels on a flow page. Drafts and the controls are not here: they always show. */
const SECTIONS = ['lead-hunts', 'reply-helper', 'event-intake', 'whats-working', 'paid-ads'];
const MAX = 1500;

export interface SiteSettings {
  kevin: { model: string | null; instructions: string };
  interface: { home: string; sections: Record<string, boolean> };
}
const defaults = (): SiteSettings => ({
  kevin: { model: null, instructions: '' },
  interface: { home: 'today', sections: Object.fromEntries(SECTIONS.map((s) => [s, true])) },
});
const fileOf = (fwHome: string) => join(fwHome, 'site-settings.json');
const bad = (message: string): never => {
  throw new AdminError(400, message);
};
/** The object under `key` (empty when absent), refused when it holds a setting that is not in `keys`. */
function part(from: Row, key: string, keys: string[]): Row {
  const v = from[key] ?? {};
  if (typeof v !== 'object' || Array.isArray(v)) return bad(`${key} must be an object`);
  const extra = Object.keys(v).find((k) => !keys.includes(k));
  return extra ? bad(`${key} has no setting named ${extra}`) : (v as Row);
}
/** A key-shaped word: one of the known shapes, or a long run of mixed letters and digits. */
const keyShaped = (t: string) =>
  hasSecretShape(t) ||
  t.split(/\s+/).some((w) => w.length >= 32 && /^[\w\-+/=.]+$/.test(w) && /\d/.test(w) && /[A-Za-z]/.test(w));

/** `now` with the edit applied. Throws AdminError(400), changing nothing, when any part is refused. */
export function applySiteSettings(now: SiteSettings, edit: unknown): SiteSettings {
  const top = part({ settings: edit }, 'settings', ['kevin', 'interface']);
  const { model, instructions } = part(top, 'kevin', ['model', 'instructions']);
  const ui = part(top, 'interface', ['home', 'sections']);
  const out = structuredClone(now);
  if (model !== undefined) {
    if (model !== null && !KEVIN_MODELS.some((m) => m.id === model))
      bad(`model must be one of ${KEVIN_MODELS.map((m) => m.id).join(', ')}`);
    out.kevin.model = model as string | null;
  }
  if (instructions !== undefined) {
    if (typeof instructions !== 'string' || instructions.trim().length > MAX)
      return bad(`instructions must be text of at most ${MAX} characters`);
    if (keyShaped(instructions))
      bad('that looks like a key, so it was not saved. Keys never go in instructions.');
    out.kevin.instructions = instructions.trim();
  }
  if (ui.home !== undefined) {
    if (!HOMES.includes(ui.home as string)) bad(`home must be one of ${HOMES.join(', ')}`);
    out.interface.home = ui.home as string;
  }
  for (const [name, show] of Object.entries(part(ui, 'sections', SECTIONS))) {
    if (typeof show !== 'boolean') return bad(`${name} must be true (show) or false (hide)`);
    out.interface.sections[name] = show;
  }
  return out;
}

/**
 * The saved settings over the defaults, with the choices the page offers. A file that cannot be read, or
 * that holds something no longer allowed, falls back to the defaults and says so in `note`.
 */
export function readSiteSettings(fwHome: string) {
  let settings = defaults();
  let note: string | null = null;
  try {
    if (existsSync(fileOf(fwHome)))
      settings = applySiteSettings(settings, JSON.parse(readFileSync(fileOf(fwHome), 'utf8')));
  } catch {
    note =
      'site-settings.json on your Mac could not be read, so the defaults are in use. Saving here replaces it.';
  }
  return { ...settings, note, models: KEVIN_MODELS, section_names: SECTIONS };
}

export function saveSiteSettings(fwHome: string, edit: unknown) {
  const { kevin, interface: ui } = readSiteSettings(fwHome);
  writeJsonAtomic(fileOf(fwHome), applySiteSettings({ kevin, interface: ui }, edit));
  return readSiteSettings(fwHome);
}
