// FW-C-113: S9, the email approval queue. Claude or ChatGPT posts a list email (a "what's new" note, a
// re-engagement email, a template for a host note) and it waits in $FW_HOME/flows/email-queue/drafts/ with its
// facts check beside the text. Nothing here sends: every queue draft is a template for a list, so approving it
// is refused, and the Owner pastes the text into Frequency Email Studio and sends it there himself.
// The check is the draft gate (FW-C-102) plus the email rules: the four tags on every Frequency link, only
// links that are live today, no typed price, no date but January 31, 2027 (beta end) and January 1, 2027 (opening day), the opt-out line, and a list
// whose members opted in.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SupervisorError } from '../overseer/index.ts';
import { checkDraft, type GateReason } from './draft-gate.ts';
import { readFacts } from './facts.ts';

export const FLOW_KEY = 'email-queue';

export interface QueueConfig {
  links: { utm_source: string; utm_medium: string; utm_campaigns: string[] };
  closed_paths: string[];
  /** Email Studio segments a queue email may go to; unsubscribe_footer says the sender adds the unsubscribe link. */
  audiences: { key: string; label: string; unsubscribe_footer: boolean }[];
  /** The facts the spec fixes, used under $FW_HOME/facts.json until Frequency serves the sheet. */
  facts_fallback: Record<string, unknown>;
  /** The only dates a draft may name: the beta end (January 31, 2027) and opening day (January 1, 2027). */
  dates: { month: string; day: number; year: number }[];
}

export type EmailBlock =
  | 'typed_price'
  | 'other_date'
  | 'closed_link'
  | 'link_tags'
  | 'no_opt_out'
  | 'not_opted_in';

const ASSET = /^[a-z0-9-]{1,48}$/;
const LINK = /https?:\/\/[^\s<>"')\]]+/gi;
const PRICE = /\$\s*\d|\d\s*\$|\b\d+(?:\.\d+)?\s*(?:dollars|usd)\b/i;
const OPT_OUT = /\bunsubscribe\b|\breply\s+["']?no\b/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const;
const DATE = new RegExp(
  `\\b(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`,
  'gi',
);
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

const readJson = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));
const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/** The shipped flow's config (an override in $FW_HOME wins), or null when the flow is not shipped. */
export function loadQueue(repoRoot: string, fwHome: string): QueueConfig | null {
  const repoDir = join(repoRoot, 'flows', FLOW_KEY);
  if (!existsSync(join(repoDir, 'stream.json'))) return null;
  const override = join(fwHome, 'flows', FLOW_KEY, 'config.json');
  return readJson(existsSync(override) ? override : join(repoDir, 'config.json')) as QueueConfig;
}

/** The email rules the draft gate does not know. Pure. */
export function emailBlocks(
  o: { body: string; subject: string; asset: string; audience: string; preheader?: string },
  cfg: QueueConfig,
): GateReason<EmailBlock>[] {
  const out: GateReason<EmailBlock>[] = [];
  const text = `${o.subject}\n${o.preheader ?? ''}\n${o.body}`;
  const prose = text.replace(LINK, ' ');
  if (PRICE.test(prose))
    out.push({ code: 'typed_price', detail: 'it types a price; point to /pricing instead' });

  const month = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase() as never) + 1;
  const named = cfg.dates.map((d) => `${d.month} ${d.day}, ${d.year}`).join(' or ');
  const allowed = (mo: number, day: number, year?: number) =>
    cfg.dates.some((d) => month(d.month) === mo && d.day === day && (year === undefined || d.year === year));
  for (const m of prose.matchAll(DATE))
    if (!allowed(month(m[1] ?? ''), Number(m[2]), m[3] === undefined ? undefined : Number(m[3])))
      out.push({ code: 'other_date', detail: `"${m[0]}" is not ${named}` });
  for (const m of prose.matchAll(ISO_DATE))
    if (!allowed(Number(m[2]), Number(m[3]), Number(m[1])))
      out.push({ code: 'other_date', detail: `${m[0]} is not ${named}` });

  for (const raw of o.body.match(LINK) ?? []) {
    const link = raw.replace(/[.,;:!?]+$/, '');
    if (!URL.canParse(link)) continue;
    const u = new URL(link);
    if (u.hostname.toLowerCase().replace(/^www\./, '') !== 'frequencylocal.com') continue;
    const path = u.pathname.replace(/\/+$/, '') || '/';
    const closed = cfg.closed_paths.find((p) =>
      p.endsWith('/') ? `${path}/`.startsWith(p) : path === p || path.startsWith(`${p}/`),
    );
    if (closed) out.push({ code: 'closed_link', detail: `${path} is not live yet` });
    if (/^\/q\/[a-z0-9-]{3,48}$/.test(path)) continue;
    const q = u.searchParams;
    const bad = [
      q.get('utm_source') !== cfg.links.utm_source && `utm_source=${cfg.links.utm_source}`,
      q.get('utm_medium') !== cfg.links.utm_medium && `utm_medium=${cfg.links.utm_medium}`,
      !cfg.links.utm_campaigns.includes(q.get('utm_campaign') ?? '') &&
        `utm_campaign=${cfg.links.utm_campaigns.join('|')}`,
      q.get('utm_content') !== o.asset && `utm_content=${o.asset}`,
    ].filter(Boolean);
    if (bad.length > 0) out.push({ code: 'link_tags', detail: `${path} needs ${bad.join(', ')}` });
  }

  const list = cfg.audiences.find((a) => a.key === o.audience);
  if (!list)
    out.push({ code: 'not_opted_in', detail: `"${o.audience}" is not a list whose members opted in` });
  if (list?.unsubscribe_footer !== true && !OPT_OUT.test(o.body))
    out.push({ code: 'no_opt_out', detail: 'it has no way to opt out (reply no or unsubscribe)' });
  return out;
}

const field = (body: Record<string, unknown>, k: string, max: number): string => {
  const v = body[k];
  if (typeof v !== 'string' || v.trim() === '') throw new SupervisorError('INVALID', `${k} is required`);
  if (v.length > max) throw new SupervisorError('INVALID', `${k} is over ${max} characters`);
  return v;
};

/** Saves one posted email with its facts check. A broken rule stores it gate_blocked; nothing sends. */
export function postEmailDraft(o: { repoRoot: string; fwHome: string; body: unknown; now?: Date }): {
  draft: Record<string, unknown>;
} {
  const cfg = loadQueue(o.repoRoot, o.fwHome);
  if (!cfg) throw new SupervisorError('NOT_FOUND', `no flow named ${FLOW_KEY}`);
  const b = isObj(o.body) ? o.body : {};
  const asset = field(b, 'asset', 48);
  if (!ASSET.test(asset))
    throw new SupervisorError('INVALID', 'asset must be 1-48 lowercase letters, digits or -');
  const subject = field(b, 'subject', 200);
  const text = field(b, 'body', 10_000);
  const audience = field(b, 'audience', 100);
  const preheader = b.preheader === undefined ? undefined : field(b, 'preheader', 200);

  const sheet = readFacts(o.fwHome);
  const facts: Record<string, unknown> = { ...cfg.facts_fallback };
  if (sheet) for (const [k, v] of Object.entries(sheet)) if (v !== null && k !== 'fetched_at') facts[k] = v;
  const gate = checkDraft(
    {
      body: text,
      subject: preheader ? `${subject}\n${preheader}` : subject,
      send_via: 'email',
      channel: 'email',
      touch: 1,
    },
    { facts, requireLink: true },
  );
  const blocks = [
    ...gate.blocks,
    ...emailBlocks({ body: text, subject, asset, audience, ...(preheader ? { preheader } : {}) }, cfg),
  ];
  const at = (o.now ?? new Date()).toISOString();
  const draft = {
    flow: FLOW_KEY,
    id: asset,
    kind: 'list_email',
    asset,
    fire_id: null,
    lead_id: `template:email-studio:${audience}`,
    channel: 'email',
    send_via: 'email_studio',
    audience,
    name: cfg.audiences.find((a) => a.key === audience)?.label ?? audience,
    tag: asset,
    subject,
    ...(preheader ? { preheader } : {}),
    body: text,
    status: blocks.length === 0 ? 'waiting_for_owner' : 'gate_blocked',
    created_at: at,
    gate: { at, blocks, warns: gate.warns, facts_from: sheet ? 'facts.json' : 'config facts_fallback' },
  };
  const dir = join(o.fwHome, 'flows', FLOW_KEY, 'drafts');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${asset}.json`);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  return { draft };
}
