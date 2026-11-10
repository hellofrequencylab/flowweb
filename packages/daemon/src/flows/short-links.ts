// FW-C-082: drafts read like a person wrote them. Every link fwd puts in a draft to the offer's site
// becomes a Frequency short link (frequency-web LIVE-2257: POST /api/webhooks/flowweb-link, signed with the
// outcomes secret), so a note ends with frequencylocal.com/q/<slug> and not a long tracked URL. The short
// link redirects to the full one, so utm_campaign and utm_content still reach Frequency. When there is no
// secret or Frequency does not answer, the long link stays: a draft is never held up by this.
// Em and en dashes never appear in a draft: noDashes swaps them for a comma.
import { CredentialError, resolveCredential } from '../creds/index.ts';
import { OUTCOMES_HANDLE, sign } from './outcomes.ts';

const PATH = '/api/webhooks/flowweb-link';
const LINK = /https?:\/\/[^\s<>"')\]]+/g;

/** The text with every em or en dash (and the spaces around it) turned into a comma and one space. */
export function noDashes(text: string): string {
  return text
    .replace(/(\d)\s*[–—]\s*(\d)/g, '$1 to $2')
    .replace(/\s*[–—]+\s*/g, ', ')
    .replace(/,\s*([,.!?;:])/g, '$1')
    .replace(/^, /gm, '');
}

export interface Shortener {
  /** The text with each flowweb link replaced by its short link where Frequency gave one. */
  shorten(text: string, title: string): Promise<string>;
}

/** No secret, no shortening: the text is kept as it is. */
const KEEP: Shortener = { shorten: async (t) => t };

/**
 * A shortener for one cycle, or one that keeps every link when the outcomes secret is not set.
 * `site` is where Frequency answers (FW_FREQUENCY_URL, else the offer's url).
 */
export function shortenerFor(o: {
  fwHome: string;
  site: string;
  log?: (line: string) => void;
  now?: () => Date;
}): Shortener {
  let secret: string;
  try {
    secret = resolveCredential(OUTCOMES_HANDLE, { home: o.fwHome });
  } catch (e) {
    if (!(e instanceof CredentialError)) o.log?.(`flowweb-link: no secret: ${(e as Error)?.message ?? e}`);
    return KEEP;
  }
  const site = o.site.replace(/\/$/, '');
  const seen = new Map<string, string>();
  const one = async (url: string, title: string): Promise<string> => {
    const known = seen.get(url);
    if (known) return known;
    const body = JSON.stringify({ url, title });
    const ts = String(Math.floor((o.now?.() ?? new Date()).getTime() / 1000));
    try {
      const res = await fetch(`${site}${PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-flowweb-timestamp': ts,
          'x-flowweb-signature': sign(secret, ts, body),
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      const a = (await res.json().catch(() => null)) as { short_url?: unknown } | null;
      const short = typeof a?.short_url === 'string' ? a.short_url : '';
      if (!res.ok || !/^https?:\/\/[^\s/]+\/q\/[a-z0-9-]{3,48}$/.test(short))
        throw new Error(`Frequency answered ${res.status}`);
      seen.set(url, short);
      return short;
    } catch (e) {
      o.log?.(`flowweb-link: kept the long link: ${(e as Error)?.message ?? e}`);
      return url;
    }
  };
  return {
    async shorten(text, title) {
      let out = text;
      for (const raw of new Set(text.match(LINK) ?? [])) {
        const tail = /[.,;:!?]+$/.exec(raw)?.[0] ?? '';
        const link = tail ? raw.slice(0, -tail.length) : raw;
        let u: URL;
        try {
          u = new URL(link);
        } catch {
          continue;
        }
        if (u.searchParams.get('utm_source') !== 'flowweb') continue;
        const short = await one(link, title);
        if (short !== link) out = out.split(link).join(short);
      }
      return out;
    },
  };
}
