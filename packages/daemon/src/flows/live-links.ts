// FW-C-117: live links only. Frequency's /start/host, /start/partner, /for/<niche> and /launch pages are
// not live yet; /create-a-space, /pricing and /help are. While a flow's funnels_live switch is false, every
// link it generates to a page that is not live goes to /create-a-space instead, with the same query tags.
// When the switch is true (or absent), links are as configured. FW_FUNNELS_LIVE=off (or 0, false) in
// fwd's environment makes every flow use live links only, whatever its config says, unless the Owner's
// stored switch (FW-C-118) is set.

/** The page every not-yet-live funnel falls back to. */
export const LIVE_FALLBACK = '/create-a-space';
const NOT_LIVE = /^\/(start\/host|start\/partner|for\/[^/?#]+|launch)(\/[^?#]*)?$/i;

// FW-C-118: the Owner's stored switch (Settings, funnels_live in the Supervisor settings). When it is true
// or false it wins over FW_FUNNELS_LIVE and every flow's config; unset keeps the env-then-config answer.
// fwd registers how to read it once its database is open, so every caller honours it without a handle.
let storedSetting: () => boolean | null = () => null;

/** Makes read() the stored switch every funnelsLive call uses by default; null clears it. Answers an undo. */
export function setFunnelsSettingReader(read: (() => boolean | null) | null): () => void {
  const mine = read ?? (() => null);
  storedSetting = mine;
  return () => {
    if (storedSetting === mine) storedSetting = () => null;
  };
}

const envOff = (env: NodeJS.ProcessEnv) => /^(off|0|false)$/i.test(env.FW_FUNNELS_LIVE?.trim() ?? '');

/**
 * The stored setting when it is true or false. Otherwise false when FW_FUNNELS_LIVE is off, 0 or false,
 * or the config says funnels_live false; else true.
 */
export function funnelsLive(
  cfg: unknown,
  env: NodeJS.ProcessEnv = process.env,
  setting: boolean | null = storedSetting(),
): boolean {
  if (typeof setting === 'boolean') return setting;
  if (envOff(env)) return false;
  return !(cfg && typeof cfg === 'object' && (cfg as { funnels_live?: unknown }).funnels_live === false);
}

export type FunnelsSource = 'setting' | 'env' | 'config';
export interface FunnelsView {
  /** The answer for every flow; null when each flow's own config decides (source config). */
  live: boolean | null;
  source: FunnelsSource;
  setting: boolean | null;
  env_off: boolean;
}

/** What decides funnel links now, for GET /v1/supervisor/funnels-live and the Settings switch. */
export function funnelsView(setting: boolean | null, env: NodeJS.ProcessEnv = process.env): FunnelsView {
  const off = envOff(env);
  if (typeof setting === 'boolean') return { live: setting, source: 'setting', setting, env_off: off };
  return off
    ? { live: false, source: 'env', setting: null, env_off: true }
    : { live: null, source: 'config', setting: null, env_off: false };
}

/** The path to link to: the fallback for a page that is not live while live is false, else the path. */
export function livePath(path: string, live: boolean): string {
  if (live) return path;
  const [p = '', rest = ''] = path.split(/(?=[?#])/, 2);
  return NOT_LIVE.test(p) ? `${LIVE_FALLBACK}${rest}` : path;
}
