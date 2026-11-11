// FW-C-102: the draft gate. Every hard copy and outreach rule becomes code, so a draft that breaks one never
// waits in the Owner's inbox. Pure: the caller passes the draft and everything it may be checked against
// (the facts sheet, the event payload, the lead's own source text, do-not-contact, touches so far).
// Blocks: an em or en dash, an emoji, a number or date found in none of those, "Midnight", no tagged
// Frequency link, over 120 words, a 4th touch, an address on do-not-contact, a restricted region.
// Warns only: a DM over 70 words, a follow-up over 40.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RESTRICTED_COUNTRIES } from './hunts.ts';

export const HARD_CAP_WORDS = 120;
export const DM_WORDS = 70;
export const FOLLOW_UP_WORDS = 40;
export const MAX_TOUCHES = 3;

export const BLOCKS = [
  'dash',
  'emoji',
  'unsourced_number',
  'midnight',
  'no_tagged_link',
  'too_long',
  'touch_limit',
  'do_not_contact',
  'restricted_region',
] as const;
export type BlockCode = (typeof BLOCKS)[number];
export type WarnCode = 'dm_long' | 'follow_up_long';
export type GateReason<C extends string> = { code: C; detail: string };

export interface GateDraft {
  body: string;
  subject?: string | null;
  /** How it goes out: a DM route (social_dm, dm, instagram, form) gets the 70-word warning. */
  send_via?: string | null;
  channel?: string | null;
  /** 1 for the first note to a person; 2 and 3 are follow-ups. */
  touch?: number | null;
  to?: string | null;
  contact_url?: string | null;
  lead_id?: string | null;
  country?: string | null;
  region?: string | null;
}

export interface GateCtx {
  /** The facts sheet ($FW_HOME/facts.json); fetched_at is not a fact a draft may quote. */
  facts?: Record<string, unknown> | null;
  /** The event payload or lead record the draft was written from. */
  payload?: unknown;
  /** The lead's own public text (event title, page text). */
  source?: string | null;
  doNotContact?: string[];
  /** Touches this person already had; the draft is the next one when it names no touch. */
  priorTouches?: number;
  /** Hosts a tagged link may point at; frequencylocal.com is always one. */
  linkHosts?: string[];
  /** Region names or ids that are off limits (beyond the EU, EEA, UK and Canada). */
  restrictedRegions?: string[];
  /** False skips only the tagged-link rule (flows whose drafts are not opted in yet). */
  requireLink?: boolean;
}

export interface GateResult {
  ok: boolean;
  blocks: GateReason<BlockCode>[];
  warns: GateReason<WarnCode>[];
}

const LINK = /https?:\/\/[^\s<>"')\]]+/gi;
const SLOT = /\{\{\s*claim_url\s*\}\}/;
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/u;
const SIGN_OFF = /\n\s*Daniel Tyack\s*\n[\s\S]*$/;
const PS = /\n\s*P\.S\.[\s\S]*$/;
const RESTRICTED_NAMES = /\b(united kingdom|england|scotland|wales|canada|europe|european union)\b/i;
const RESTRICTED_TLDS = new Set([...RESTRICTED_COUNTRIES].map((c) => c.toLowerCase()).concat(['eu', 'uk']));

const str = (x: unknown) => (typeof x === 'string' ? x : '');
const digitRuns = (text: string) => (text.match(/\d+/g) ?? []).map((d) => d.replace(/^0+(?=\d)/, ''));

/** The words a reader counts: the message without links, the sign-off block or the P.S. */
export function wordCount(body: string): number {
  const msg = body.replace(PS, '').replace(SIGN_OFF, '').replace(LINK, ' ');
  return msg.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Every digit run a draft may quote: from the facts (not fetched_at), the payload, the source and its own links. */
function allowedDigits(text: string, ctx: GateCtx): Set<string> {
  const { fetched_at: _f, ...facts } = ctx.facts ?? {};
  const pool = [JSON.stringify(facts), JSON.stringify(ctx.payload ?? null), str(ctx.source)];
  pool.push(...(text.match(LINK) ?? []));
  return new Set(pool.flatMap(digitRuns));
}

function tagged(raw: string, hosts: string[]): boolean {
  const link = raw.replace(/[.,;:!?]+$/, '');
  if (!URL.canParse(link)) return false;
  const u = new URL(link);
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!hosts.includes(host)) return false;
  return u.searchParams.get('utm_source') !== null || /^\/q\/[a-z0-9-]{3,48}$/.test(u.pathname);
}

function hostOf(x: string): string {
  if (x.includes('@') && !x.includes('/')) return x.split('@').pop() ?? '';
  return URL.canParse(x) ? new URL(x).hostname : '';
}

function onList(dnc: string[], draft: GateDraft): string | null {
  const list = dnc
    .map((x) =>
      x
        .trim()
        .toLowerCase()
        .replace(/^mailto:/, ''),
    )
    .filter(Boolean);
  for (const raw of [draft.to, draft.contact_url, draft.lead_id]) {
    const v = str(raw).trim().toLowerCase();
    if (!v) continue;
    const host = hostOf(v).replace(/^www\./, '');
    const hit = list.find(
      (e) =>
        e === v ||
        (host !== '' &&
          !e.includes('/') &&
          (e === `@${host}` || (!e.includes('@') && (host === e || host.endsWith(`.${e}`))))),
    );
    if (hit) return hit;
  }
  return null;
}

function restricted(draft: GateDraft, ctx: GateCtx): string | null {
  const c = str(draft.country).toUpperCase();
  if (RESTRICTED_COUNTRIES.has(c)) return `country ${c}`;
  for (const x of [draft.to, draft.contact_url]) {
    const tld = hostOf(str(x).toLowerCase()).split('.').pop() ?? '';
    if (RESTRICTED_TLDS.has(tld)) return `.${tld} address`;
  }
  const region = str(draft.region);
  if (RESTRICTED_NAMES.test(region)) return `region ${region}`;
  const extra = (ctx.restrictedRegions ?? []).map((r) => r.toLowerCase());
  if (region && extra.includes(region.toLowerCase())) return `region ${region}`;
  return null;
}

/** Checks one draft against every hard rule. ok is false when anything blocks; warns never block. */
export function checkDraft(draft: GateDraft, ctx: GateCtx = {}): GateResult {
  const blocks: GateReason<BlockCode>[] = [];
  const warns: GateReason<WarnCode>[] = [];
  const body = str(draft.body);
  const text = `${str(draft.subject)}\n${body}`;
  const block = (code: BlockCode, detail: string) => blocks.push({ code, detail });

  if (/[–—]/.test(text)) block('dash', 'it has an em or en dash');
  const emoji = EMOJI.exec(text);
  if (emoji) block('emoji', `it has an emoji (${emoji[0]})`);

  const allowed = allowedDigits(text, ctx);
  const loose = [...new Set(digitRuns(text.replace(LINK, ' ')))].filter((d) => !allowed.has(d));
  if (loose.length > 0)
    block('unsourced_number', `${loose.join(', ')} is not in the facts sheet, the payload or the source`);

  if (/\bmidnight\b/i.test(text.replace(LINK, ' '))) block('midnight', 'it says "Midnight"');

  const hosts = [
    'frequencylocal.com',
    ...(ctx.linkHosts ?? []).map((h) => h.toLowerCase().replace(/^www\./, '')),
  ];
  if (
    ctx.requireLink !== false &&
    !SLOT.test(body) &&
    !(body.match(LINK) ?? []).some((l) => tagged(l, hosts))
  )
    block('no_tagged_link', 'it has no tagged Frequency link');

  const words = wordCount(body);
  if (words > HARD_CAP_WORDS) block('too_long', `${words} words, over the ${HARD_CAP_WORDS}-word cap`);

  const touch = typeof draft.touch === 'number' ? draft.touch : (ctx.priorTouches ?? 0) + 1;
  if (touch > MAX_TOUCHES) block('touch_limit', `touch ${touch}, over the lifetime ${MAX_TOUCHES}`);

  const dnc = onList(ctx.doNotContact ?? [], draft);
  if (dnc) block('do_not_contact', `${dnc} is on do-not-contact`);
  const where = restricted(draft, ctx);
  if (where) block('restricted_region', `${where} is a place the flow does not write to`);

  const route = `${str(draft.send_via)} ${str(draft.channel)}`.toLowerCase();
  if (touch > 1 && words > FOLLOW_UP_WORDS)
    warns.push({ code: 'follow_up_long', detail: `${words} words, the follow-up aim is ${FOLLOW_UP_WORDS}` });
  else if (/dm|instagram|facebook|form|platform/.test(route) && words > DM_WORDS)
    warns.push({ code: 'dm_long', detail: `${words} words, the DM aim is ${DM_WORDS}` });

  return { ok: blocks.length === 0, blocks, warns };
}

/** What a draft record gains from the gate: gate_blocked with its reasons, or its warnings. */
export function gateFields(r: GateResult, at: string): Record<string, unknown> {
  if (!r.ok) return { status: 'gate_blocked', gate: { at, blocks: r.blocks, warns: r.warns } };
  return r.warns.length > 0 ? { gate: { at, blocks: [], warns: r.warns } } : {};
}

/**
 * Gates a draft before it is stored. A blocked draft is rewritten once when the caller gives a rewrite hook
 * (the hook gets the reasons) and checked again; the result says which text to keep.
 */
export async function gateWithRewrite(
  draft: GateDraft,
  ctx: GateCtx,
  rewrite?: (d: GateDraft, blocks: GateReason<BlockCode>[]) => Promise<GateDraft | null>,
): Promise<{ draft: GateDraft; result: GateResult; rewritten: boolean }> {
  const first = checkDraft(draft, ctx);
  if (first.ok || !rewrite) return { draft, result: first, rewritten: false };
  const next = await rewrite(draft, first.blocks).catch(() => null);
  if (!next || typeof next.body !== 'string') return { draft, result: first, rewritten: false };
  return { draft: next, result: checkDraft(next, ctx), rewritten: true };
}

/**
 * Stores one draft in a flow's drafts folder with the gate applied: a clean draft waits for the Owner, a
 * blocked one is stored gate_blocked with its reasons (rewritten once first when a hook is given). For flows
 * that write their own drafts; fwd's cycle checks before it hands anything off.
 */
export async function persistDraft(o: {
  dir: string;
  doc: Record<string, unknown> & { id: string };
  draft: GateDraft;
  ctx: GateCtx;
  rewrite?: (d: GateDraft, blocks: GateReason<BlockCode>[]) => Promise<GateDraft | null>;
  now?: Date;
}): Promise<Record<string, unknown>> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(o.doc.id))
    throw new Error('draft id must be 1-100 letters, digits, _ or -');
  const at = (o.now ?? new Date()).toISOString();
  const g = await gateWithRewrite(o.draft, o.ctx, o.rewrite);
  const doc = {
    status: 'waiting_for_owner',
    created_at: at,
    ...o.doc,
    body: g.draft.body,
    ...(g.draft.subject !== undefined ? { subject: g.draft.subject } : {}),
    ...(g.rewritten ? { rewritten_by_gate: true } : {}),
    ...gateFields(g.result, at),
  };
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  const path = join(o.dir, `${o.doc.id}.json`);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  return doc;
}
