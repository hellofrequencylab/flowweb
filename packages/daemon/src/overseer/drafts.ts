// FW-C-046: Copilot. A cycle's drafts wait in $FW_HOME/flows/<key>/drafts/ for the Owner, who lists
// them and approves or rejects each one. Approving hands the draft off exactly as Autopilot does (the
// same outbox file and notification.queued event, deduplicated on the same key), so approving twice
// changes nothing. A rejected draft is never handed off.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Writer } from '@fw/eventlog';
import { dncMatch, doNotContactList } from '../flows/opt-out.ts';
import { handOff, SupervisorError, shippedFlows } from './index.ts';

export interface DraftView {
  id: string;
  fire_id: string | null;
  lead_id: string | null;
  channel: string | null;
  subject: string | null;
  body: string;
  status: string;
  held?: string;
  created_at: string | null;
  approved_at?: string;
  rejected_at?: string;
  edited_at?: string;
  /** FW-C-054: the draft id in Frequency's slug form; every flowweb link in the body carries it. */
  tag?: string;
  sent_at?: string;
  replied_at?: string;
  declined_at?: string;
  /** FW-C-065: who the draft goes to (email leads), and what Frequency's CRM last said about them. */
  to?: string;
  name?: string;
  crm?: Record<string, unknown>;
  /** FW-C-102: why the draft gate blocked it (status gate_blocked), or what it only warned about. */
  gate?: Record<string, unknown>;
}

const ID = /^[A-Za-z0-9_-]{1,100}$/;

function draftsDir(repoRoot: string, fwHome: string, flow: string): string {
  if (!shippedFlows(repoRoot).some((f) => f.key === flow))
    throw new SupervisorError('NOT_FOUND', `no flow named ${flow}`);
  return join(fwHome, 'flows', flow, 'drafts');
}

function view(doc: Record<string, unknown>): DraftView {
  const str = (k: string) => (typeof doc[k] === 'string' ? (doc[k] as string) : null);
  return {
    id: String(doc.id),
    fire_id: str('fire_id'),
    lead_id: str('lead_id'),
    channel: str('channel'),
    subject: str('subject'),
    body: str('body') ?? '',
    status: str('status') ?? 'waiting_for_owner',
    ...(str('held') ? { held: str('held') as string } : {}),
    created_at: str('created_at'),
    ...(str('approved_at') ? { approved_at: str('approved_at') as string } : {}),
    ...(str('rejected_at') ? { rejected_at: str('rejected_at') as string } : {}),
    ...(str('edited_at') ? { edited_at: str('edited_at') as string } : {}),
    ...Object.fromEntries(
      (['tag', 'sent_at', 'replied_at', 'declined_at', 'to', 'name'] as const).flatMap((k) =>
        str(k) ? [[k, str(k)]] : [],
      ),
    ),
    ...(doc.crm && typeof doc.crm === 'object' && !Array.isArray(doc.crm)
      ? { crm: doc.crm as Record<string, unknown> }
      : {}),
    ...(doc.gate && typeof doc.gate === 'object' && !Array.isArray(doc.gate)
      ? { gate: doc.gate as Record<string, unknown> }
      : {}),
  };
}

/** The flow's drafts, newest first. */
export function listDrafts(repoRoot: string, fwHome: string, flow: string): DraftView[] {
  const dir = draftsDir(repoRoot, fwHome, flow);
  if (!existsSync(dir)) return [];
  const out: DraftView[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const doc = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>;
      if (typeof doc.id === 'string') out.push(view(doc));
    } catch {
      // A file being written or not a draft: skip it.
    }
  }
  return out.sort(
    (a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '') || b.id.localeCompare(a.id),
  );
}

function load(repoRoot: string, fwHome: string, flow: string, id: string) {
  if (!ID.test(id)) throw new SupervisorError('INVALID', 'draft id must be 1-100 letters, digits, _ or -');
  const path = join(draftsDir(repoRoot, fwHome, flow), `${id}.json`);
  if (!existsSync(path)) throw new SupervisorError('NOT_FOUND', `${flow} has no draft ${id}`);
  return { path, doc: JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> };
}

function save(path: string, doc: Record<string, unknown>): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

const conflict = (why: string, words: string) => new SupervisorError('CONFLICT', `${why}: ${words}`);

/** Hands one draft off on the Owner's approval; refused (CONFLICT) when it may not go out. */
export function approveDraft(o: {
  writer: Writer;
  repoRoot: string;
  fwHome: string;
  flow: string;
  id: string;
}): DraftView {
  const { path, doc } = load(o.repoRoot, o.fwHome, o.flow, o.id);
  if (doc.status === 'handed_off') return view(doc);
  if (doc.status === 'rejected') throw conflict('rejected', 'The Owner rejected this draft.');
  // FW-C-102: a draft the gate blocked breaks a hard rule, so it never goes out.
  if (doc.status === 'gate_blocked') throw conflict('gate_blocked', 'This draft breaks a hard rule.');
  // FW-C-115: nobody on do-not-contact gets a draft, whatever its status says.
  const listed = dncMatch(doNotContactList(o.fwHome, o.flow), doc);
  if (doc.status === 'do_not_contact' || listed)
    throw conflict('do_not_contact', `${listed ?? 'This person'} is on do-not-contact.`);
  const lead = typeof doc.lead_id === 'string' ? doc.lead_id : '';
  if (lead === '') throw conflict('no_recipient', 'This draft names no lead to send to.');
  if (lead.startsWith('template:'))
    throw conflict('template', 'This is a template, not a message to a lead.');
  if (typeof doc.channel !== 'string' || doc.channel === '')
    throw conflict('unknown_channel', 'This draft names no channel.');
  if (typeof doc.body !== 'string' || doc.body === '') throw conflict('empty', 'This draft has no body.');
  const r = handOff({
    writer: o.writer,
    repoRoot: o.repoRoot,
    fwHome: o.fwHome,
    flow: o.flow,
    item: { id: o.id, channel: doc.channel, body: doc.body },
    approved: true,
  });
  if (r.outcome !== 'queued') throw new SupervisorError('CONFLICT', r.reason ?? 'held');
  const { held: _held, ...rest } = doc;
  const next = { ...rest, status: 'handed_off', approved_at: new Date().toISOString() };
  save(path, next);
  return view(next);
}

/** Marks one draft rejected; a draft already handed off cannot be taken back. */
export function rejectDraft(o: { repoRoot: string; fwHome: string; flow: string; id: string }): DraftView {
  const { path, doc } = load(o.repoRoot, o.fwHome, o.flow, o.id);
  if (doc.status === 'rejected') return view(doc);
  if (doc.status === 'handed_off')
    throw conflict('handed_off', 'This draft is already in the outbox and cannot be taken back.');
  const next = { ...doc, status: 'rejected', rejected_at: new Date().toISOString() };
  save(path, next);
  return view(next);
}

/** Longest subject or body an edit may write. */
export const MAX_DRAFT_FIELD = 20_000;

/**
 * FW-C-050: the Owner changes a draft's subject and text before it goes out. The status stays as it
 * was; edited_at says when. A draft already in the outbox is refused (CONFLICT handed_off) so the
 * outbox file is never changed after the hand-off.
 */
export function editDraft(o: {
  repoRoot: string;
  fwHome: string;
  flow: string;
  id: string;
  subject?: unknown;
  body?: unknown;
}): DraftView {
  const has = (v: unknown) => v !== undefined;
  if (!has(o.subject) && !has(o.body)) throw new SupervisorError('INVALID', 'give a subject, a body or both');
  for (const [name, v] of [
    ['subject', o.subject],
    ['body', o.body],
  ] as const) {
    if (!has(v)) continue;
    if (typeof v !== 'string') throw new SupervisorError('INVALID', `${name} must be text`);
    if (v.length > MAX_DRAFT_FIELD)
      throw new SupervisorError('INVALID', `${name} is longer than ${MAX_DRAFT_FIELD} characters`);
  }
  if (has(o.body) && (o.body as string).trim() === '')
    throw new SupervisorError('INVALID', 'body cannot be empty');
  const { path, doc } = load(o.repoRoot, o.fwHome, o.flow, o.id);
  if (doc.status === 'handed_off')
    throw conflict('handed_off', 'This draft is already in the outbox and cannot be changed.');
  const next = {
    ...doc,
    ...(has(o.subject) ? { subject: o.subject as string } : {}),
    ...(has(o.body) ? { body: o.body as string } : {}),
    edited_at: new Date().toISOString(),
  };
  save(path, next);
  return view(next);
}

/**
 * FW-C-054: the tag a draft's links carry as utm_content, so Frequency can trace a signup back to the
 * draft. It is the draft id in Frequency's slug form: lower case, a-z 0-9 _ -, at most 48 characters.
 */
export function draftTag(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .slice(0, 48);
}

/** Adds utm_content=<tag> to every link in the text that carries utm_source=flowweb. Other text is kept. */
export function tagLinks(text: string, tag: string): string {
  return text.replace(/https?:\/\/[^\s<>"')\]]+/g, (raw) => {
    const tail = /[.,;:!?]+$/.exec(raw)?.[0] ?? '';
    const link = tail ? raw.slice(0, -tail.length) : raw;
    let u: URL;
    try {
      u = new URL(link);
    } catch {
      return raw;
    }
    if (u.searchParams.get('utm_source') !== 'flowweb') return raw;
    u.searchParams.set('utm_content', tag);
    return `${u.toString()}${tail}`;
  });
}

/**
 * FW-C-114: adds ref=<tag> to every link in the text that carries utm_source=flowweb and has no ref yet,
 * so each draft can be learned from on its own. utm_source stays flowweb. Other text is kept.
 */
export function refLinks(text: string, tag: string): string {
  return text.replace(/https?:\/\/[^\s<>"')\]]+/g, (raw) => {
    const tail = /[.,;:!?]+$/.exec(raw)?.[0] ?? '';
    let u: URL;
    try {
      u = new URL(tail ? raw.slice(0, -tail.length) : raw);
    } catch {
      return raw;
    }
    if (u.searchParams.get('utm_source') !== 'flowweb' || u.searchParams.has('ref')) return raw;
    u.searchParams.set('ref', tag);
    return `${u.toString()}${tail}`;
  });
}

export const DRAFT_OUTCOMES = ['sent', 'replied', 'declined'] as const;
export type DraftOutcome = (typeof DRAFT_OUTCOMES)[number];

/**
 * FW-C-054: the Owner says what happened to a draft they sent by hand. sent, replied and declined each
 * stamp their time once (a repeat keeps the first); replied and declined stamp sent_at too when it is
 * missing. declined is an opt-out: the draft's address, else its contact page, else its lead id goes on
 * the flow's do-not-contact list. The status is never changed and nothing is sent.
 */
export function markDraft(o: {
  repoRoot: string;
  fwHome: string;
  flow: string;
  id: string;
  outcome: unknown;
  now?: Date;
}): DraftView {
  if (!(DRAFT_OUTCOMES as readonly unknown[]).includes(o.outcome))
    throw new SupervisorError('INVALID', `outcome must be one of ${DRAFT_OUTCOMES.join(', ')}`);
  const outcome = o.outcome as DraftOutcome;
  const { path, doc } = load(o.repoRoot, o.fwHome, o.flow, o.id);
  if (doc.status === 'rejected')
    throw conflict('rejected', 'The Owner rejected this draft, so it was never sent.');
  const at = (o.now ?? new Date()).toISOString();
  const next: Record<string, unknown> = { ...doc };
  if (typeof next.sent_at !== 'string') next.sent_at = at;
  const field = `${outcome}_at`;
  if (typeof next[field] !== 'string') next[field] = at;
  if (outcome === 'declined') {
    const pick = (k: string) => (typeof doc[k] === 'string' && doc[k] !== '' ? (doc[k] as string) : null);
    const key = (pick('to') ?? pick('contact_url') ?? pick('lead_id'))?.toLowerCase();
    if (key && !key.startsWith('template:')) addToDoNotContact(o.fwHome, o.flow, key);
  }
  save(path, next);
  return view(next);
}

/** Appends one entry to $FW_HOME/flows/<flow>/state.json do_not_contact, keeping everything else. */
function addToDoNotContact(fwHome: string, flow: string, key: string): void {
  const p = join(fwHome, 'flows', flow, 'state.json');
  const state = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>) : {};
  const list = Array.isArray(state.do_not_contact) ? (state.do_not_contact as unknown[]).map(String) : [];
  if (list.some((x) => x.toLowerCase() === key)) return;
  mkdirSync(join(fwHome, 'flows', flow), { recursive: true, mode: 0o700 });
  save(p, { ...state, do_not_contact: [...list, key] });
}
