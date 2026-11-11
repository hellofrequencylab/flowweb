// FW-C-115: live links only. Frequency's /start/host, /start/partner, /for/<niche> and /launch pages are
// not live yet; /create-a-space, /pricing and /help are. While a flow's funnels_live switch is false, every
// link it generates to a page that is not live goes to /create-a-space instead, with the same query tags.
// When the switch is true (or absent), links are as configured. FW_FUNNELS_LIVE=off (or 0, false) in
// fwd's environment makes every flow use live links only, whatever its config says.

/** The page every not-yet-live funnel falls back to. */
export const LIVE_FALLBACK = '/create-a-space';
const NOT_LIVE = /^\/(start\/host|start\/partner|for\/[^/?#]+|launch)(\/[^?#]*)?$/i;

/** False when FW_FUNNELS_LIVE is off, 0 or false, or the config says funnels_live false; else true. */
export function funnelsLive(cfg: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  if (/^(off|0|false)$/i.test(env.FW_FUNNELS_LIVE?.trim() ?? '')) return false;
  return !(cfg && typeof cfg === 'object' && (cfg as { funnels_live?: unknown }).funnels_live === false);
}

/** The path to link to: the fallback for a page that is not live while live is false, else the path. */
export function livePath(path: string, live: boolean): string {
  if (live) return path;
  const [p = '', rest = ''] = path.split(/(?=[?#])/, 2);
  return NOT_LIVE.test(p) ? `${LIVE_FALLBACK}${rest}` : path;
}
