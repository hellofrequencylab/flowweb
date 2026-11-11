// FW-C-108: the reply helper. The Owner pastes a host's reply; fwd reads its intent and drafts an answer
// from the flow's reply tree (flows/<key>/reply-tree.json), which cites only its facts block. Keyword rules
// decide first; only when none match does the flow's engine pick one label from the tree's closed list.
// The inbound text is data: it never reaches the draft, which is built from the tree alone. A "no" drafts
// nothing, puts the sender on the do-not-contact list the same day and ends their sequence. Nothing sends.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { draftTag } from '../overseer/drafts.ts';
import { funnelsLive, livePath } from './live-links.ts';
import { retireDrafts } from './opt-out.ts';

export const MAX_REPLY_TEXT = 10_000;
export const REPLY_WORDS = 70;

type Answered = { answer?: string; keywords?: string[] };
export interface ReplyTree {
  site: string;
  /** False while Frequency's /for, /start/host and /launch pages are not live (FW-C-115). */
  funnels_live?: boolean;
  utm: Record<string, string>;
  facts: Record<string, string | number>;
  links: Record<string, string>;
  default_niche: string;
  niches: Record<
    string,
    { label: string; path: string; keywords: string[]; answers?: Record<string, string> }
  >;
  order: string[];
  intents: Record<
    string,
    Answered & { opt_out?: boolean; first_words?: string[]; first_words_except?: string[] }
  >;
}

export interface ReplyInput {
  lead_id?: string;
  contact?: string;
  niche?: string;
  text: string;
}

export interface ReplyDeps {
  repoRoot: string;
  fwHome: string;
  flow: string;
  now?: Date;
  /** The flow's engine, asked only when no rule matches. Answers a label; anything off the list is unclear. */
  engine?: (text: string, labels: string[]) => Promise<string | null>;
}

export interface ReplyResult {
  intent: string;
  by: 'rules' | 'engine' | 'none';
  niche: string;
  do_not_contact: boolean;
  sequence_ended: boolean;
  /** Waiting drafts an opt-out moved to do_not_contact, as flow/id. */
  drafts_stopped?: string[];
  draft: Record<string, unknown> | null;
  gate: { by: 'draft-gate' | 'reply-helper'; ok: boolean; blocks: { code: string; detail: string }[] } | null;
}

export class ReplyError extends Error {
  readonly status: 400 | 404;
  constructor(status: 400 | 404, message: string) {
    super(message);
    this.status = status;
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const readJson = (p: string): unknown => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};
function writeAtomic(path: string, doc: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** The flow's reply tree, or null when the flow has none. */
export function loadTree(repoRoot: string, flow: string): ReplyTree | null {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(flow)) return null;
  const t = readJson(join(repoRoot, 'flows', flow, 'reply-tree.json'));
  return isObj(t) && isObj(t.niches) && isObj(t.intents) && Array.isArray(t.order)
    ? (t as unknown as ReplyTree)
    : null;
}

const norm = (s: string) => ` ${s.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ')} `;
function has(text: string, kw: string): boolean {
  const k = kw.toLowerCase();
  if (!/[a-z]/.test(k)) return text.includes(k);
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z'])${esc}([^a-z]|$)`).test(text);
}

/** The intent the keyword rules read, or null when none matches. */
export function classifyByRules(tree: ReplyTree, raw: string): string | null {
  const text = norm(raw);
  for (const name of tree.order) {
    const i = tree.intents[name];
    if (!i) continue;
    if (i.first_words?.length) {
      const lead = text.trim().replace(/^[^a-z]+/, '');
      const first = /^[a-z']+/.exec(lead)?.[0] ?? '';
      const excused = (i.first_words_except ?? []).some((e) => lead.startsWith(e));
      if (i.first_words.includes(first) && !excused) return name;
    }
    if ((i.keywords ?? []).some((k) => has(text, k))) return name;
  }
  return null;
}

function nicheOf(tree: ReplyTree, fwHome: string, flow: string, o: ReplyInput): string {
  if (o.niche && tree.niches[o.niche]) return o.niche;
  const state = readJson(join(fwHome, 'flows', flow, 'state.json'));
  const leads = isObj(state) && Array.isArray(state.leads) ? (state.leads as Record<string, unknown>[]) : [];
  const lead = o.lead_id ? leads.find((l) => isObj(l) && l.id === o.lead_id) : undefined;
  if (lead && typeof lead.niche === 'string' && tree.niches[lead.niche]) return lead.niche;
  if (lead?.kind === 'venue' && tree.niches.venue) return 'venue';
  const text = norm(o.text);
  const hit = Object.entries(tree.niches).find(([, n]) => n.keywords.some((k) => has(text, k)));
  return hit?.[0] ?? tree.default_niche;
}

function link(tree: ReplyTree, path: string, content: string): string {
  const u = new URL(livePath(path, funnelsLive(tree)), tree.site);
  for (const [k, v] of Object.entries(tree.utm)) u.searchParams.set(k, v);
  u.searchParams.set('utm_content', content);
  return u.toString();
}

/** The answer for one intent and niche, filled from the tree's facts and links only. */
export function compose(tree: ReplyTree, intent: string, niche: string, tag: string): string | null {
  const n = tree.niches[niche] ?? tree.niches[tree.default_niche];
  const template = n?.answers?.[intent] ?? tree.intents[intent]?.answer;
  if (!n || !template) return null;
  const content = `${niche}.${tag}`;
  const slots: Record<string, string> = {
    door: link(tree, n.path, content),
    label: n.label,
    ...Object.fromEntries(Object.entries(tree.links).map(([k, p]) => [k, link(tree, p, content)])),
    ...Object.fromEntries(Object.entries(tree.facts).map(([k, v]) => [k, String(v)])),
  };
  return template.replace(/\{([a-z_]+)\}/g, (m, k: string) => slots[k] ?? m);
}

const LINK = /https?:\/\/[^\s<>"')\]]+/g;
export const wordCount = (body: string) =>
  body
    .replace(LINK, ' ')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** The helper's own hard checks, run on every draft whether or not the shared draft gate is present. */
export function ownChecks(tree: ReplyTree, body: string): { code: string; detail: string }[] {
  const out: { code: string; detail: string }[] = [];
  const prose = body.replace(LINK, ' ');
  if (/[–—]/.test(body) || /\s-\s/.test(prose)) out.push({ code: 'dash', detail: 'it has a dash' });
  if (/[\p{Extended_Pictographic}]/u.test(body)) out.push({ code: 'emoji', detail: 'it has an emoji' });
  if (/midnight/i.test(prose)) out.push({ code: 'midnight', detail: 'it says "Midnight"' });
  if (/\$|\d\s*(dollars|usd)\b/i.test(prose)) out.push({ code: 'price', detail: 'it types a price' });
  const allowed = new Set(JSON.stringify(tree.facts).match(/\d+/g) ?? []);
  const loose = (prose.match(/\d+/g) ?? []).filter((d) => !allowed.has(d));
  if (loose.length) out.push({ code: 'unsourced_number', detail: `${loose.join(', ')} is not in the facts` });
  if (!(body.match(LINK) ?? []).some((l) => new URL(l).searchParams.get('utm_source') === 'flowweb'))
    out.push({ code: 'no_tagged_link', detail: 'it has no tagged Frequency link' });
  const words = wordCount(body);
  if (words >= REPLY_WORDS)
    out.push({ code: 'too_long', detail: `${words} words, want under ${REPLY_WORDS}` });
  return out;
}

type GateFn = (
  d: Record<string, unknown>,
  ctx: Record<string, unknown>,
) => { ok: boolean; blocks: { code: string; detail: string }[] };
/** The shared draft gate (flows/draft-gate.ts) when this checkout has it; null otherwise. */
async function sharedGate(): Promise<GateFn | null> {
  try {
    const spec = new URL('./draft-gate.ts', import.meta.url).href;
    const m = (await import(spec)) as { checkDraft?: unknown };
    return typeof m.checkDraft === 'function' ? (m.checkDraft as GateFn) : null;
  } catch {
    return null;
  }
}

function doNotContact(fwHome: string, flow: string): string[] {
  const s = readJson(join(fwHome, 'flows', flow, 'state.json'));
  return isObj(s) && Array.isArray(s.do_not_contact) ? s.do_not_contact.map(String) : [];
}

/** Adds the keys to state.json do_not_contact, keeping everything else. Answers whether any was added. */
function addDoNotContact(fwHome: string, flow: string, keys: string[]): boolean {
  if (keys.length === 0) return false;
  const dir = join(fwHome, 'flows', flow);
  const p = join(dir, 'state.json');
  const s = readJson(p);
  const state = isObj(s) ? s : {};
  const list = Array.isArray(state.do_not_contact) ? state.do_not_contact.map(String) : [];
  const add = keys.filter((k) => !list.some((x) => x.toLowerCase() === k));
  if (add.length > 0) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeAtomic(p, { ...state, do_not_contact: [...list, ...add] });
  }
  return true;
}

/** Any reply ends the person's sequence (sequence.json, when the flow keeps one). Answers whether one ended. */
function endSequence(fwHome: string, flow: string, keys: string[], reason: string, at: string): boolean {
  const p = join(fwHome, 'flows', flow, 'sequence.json');
  const s = existsSync(p) ? readJson(p) : null;
  if (!isObj(s) || !isObj(s.leads)) return false;
  let ended = false;
  for (const [k, raw] of Object.entries(s.leads)) {
    if (!isObj(raw) || raw.state === 'closed') continue;
    const ids = [k, raw.lead, raw.email, raw.contact].map((x) => String(x ?? '').toLowerCase());
    if (!keys.some((x) => ids.includes(x))) continue;
    Object.assign(raw, { state: 'closed', closed_reason: reason, closed_at: at, next_due_at: null });
    ended = true;
  }
  if (ended) writeAtomic(p, s);
  return ended;
}

const opt = (v: unknown, name: string, max = 500): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > max)
    throw new ReplyError(400, `${name} must be text up to ${max} characters`);
  return v.trim();
};

/** Checks the body of POST /v1/flows/{key}/replies. */
export function replyInput(body: Record<string, unknown>): ReplyInput {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text === '') throw new ReplyError(400, 'paste the reply as text');
  if (text.length > MAX_REPLY_TEXT)
    throw new ReplyError(400, `the reply is longer than ${MAX_REPLY_TEXT} characters`);
  const lead_id = opt(body.lead_id, 'lead_id', 200);
  const contact = opt(body.contact, 'contact');
  const niche = opt(body.niche, 'niche', 40);
  return {
    text,
    ...(lead_id ? { lead_id } : {}),
    ...(contact ? { contact } : {}),
    ...(niche ? { niche } : {}),
  };
}

/** Reads one pasted reply and drafts the answer for the Owner, or puts the sender on do-not-contact. */
export async function draftReply(d: ReplyDeps, body: Record<string, unknown>): Promise<ReplyResult> {
  const tree = loadTree(d.repoRoot, d.flow);
  if (!tree) throw new ReplyError(404, `${d.flow} has no reply tree`);
  const o = replyInput(body);
  const now = d.now ?? new Date();
  const at = now.toISOString();
  const labels = Object.keys(tree.intents).filter((k) => k !== 'unclear');
  let intent = classifyByRules(tree, o.text);
  let by: ReplyResult['by'] = intent ? 'rules' : 'none';
  if (!intent && d.engine) {
    let said: string | null = null;
    try {
      said = await d.engine(o.text, labels);
    } catch {
      said = null;
    }
    // The engine picks a label and nothing else: any other answer is unclear.
    if (said && labels.includes(said)) {
      intent = said;
      by = 'engine';
    }
  }
  intent ??= 'unclear';
  const niche = nicheOf(tree, d.fwHome, d.flow, o);
  const keys = [o.contact, o.lead_id].filter((x): x is string => !!x).map((x) => x.toLowerCase());

  if (tree.intents[intent]?.opt_out) {
    const listed = addDoNotContact(d.fwHome, d.flow, keys);
    const ended = endSequence(d.fwHome, d.flow, keys, 'do_not_contact', at);
    // Their drafts that were waiting in any flow stop waiting today (FW-C-115).
    const stopped = retireDrafts(d.fwHome, keys, at);
    return {
      intent,
      by,
      niche,
      do_not_contact: listed,
      sequence_ended: ended,
      drafts_stopped: stopped,
      draft: null,
      gate: null,
    };
  }
  const ended = endSequence(d.fwHome, d.flow, keys, 'replied', at);

  const stamp = at.replace(/[^0-9]/g, '').slice(0, 14);
  const id = `reply-${stamp}-${Math.random().toString(16).slice(2, 8)}`;
  const tag = draftTag(id);
  const text = compose(tree, intent, niche, tag);
  if (!text) throw new ReplyError(404, `the reply tree has no answer for ${intent}`);

  let blocks = ownChecks(tree, text);
  let gateBy: 'draft-gate' | 'reply-helper' = 'reply-helper';
  const gate = await sharedGate();
  if (gate) {
    gateBy = 'draft-gate';
    const r = gate(
      {
        body: text,
        send_via: 'reply',
        channel: 'reply',
        touch: 1,
        lead_id: o.lead_id ?? null,
        to: o.contact ?? null,
      },
      { facts: tree.facts, doNotContact: doNotContact(d.fwHome, d.flow) },
    );
    blocks = [...blocks, ...r.blocks.filter((b) => !blocks.some((x) => x.code === b.code))];
  }
  const ok = blocks.length === 0;
  const draft: Record<string, unknown> = {
    id,
    fire_id: null,
    lead_id: o.lead_id ?? (o.contact ? o.contact.toLowerCase() : null),
    ...(o.contact ? (o.contact.includes('@') ? { to: o.contact } : { contact_url: o.contact }) : {}),
    channel: 'reply',
    route: 'reply',
    send_via: 'reply',
    subject: null,
    body: text,
    status: ok ? 'waiting_for_owner' : 'gate_blocked',
    ...(ok ? {} : { gate: { at, blocks } }),
    created_at: at,
    tag,
    intent,
    niche,
    // The pasted reply, kept as data for the Owner. It never feeds the draft.
    inbound: { text: o.text, untrusted: true },
  };
  const dir = join(d.fwHome, 'flows', d.flow, 'drafts');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeAtomic(join(dir, `${id}.json`), draft);
  return {
    intent,
    by,
    niche,
    do_not_contact: false,
    sequence_ended: ended,
    draft,
    gate: { by: gateBy, ok, blocks },
  };
}
