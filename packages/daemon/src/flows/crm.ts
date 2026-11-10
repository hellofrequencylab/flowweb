// FW-C-065: every lead a flow drafts to can be followed in Frequency's CRM. fwd posts each email draft's
// whole state (drafted, sent, they replied, they said no) to Frequency, signed with the outcomes secret
// (frequency-web /api/webhooks/flowweb-crm, LIVE-2256), right after the Owner marks a draft and once a day.
// Frequency keeps one contact and one conversation per lead and answers where the lead is, including
// whether they signed up. fwd writes that answer onto the draft as `crm`, so the Flows page can show it.
// Nothing is sent to the lead: this only tells Frequency what the Owner already did.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CredentialError, resolveCredential } from '../creds/index.ts';
import { loadHunts } from './hunts.ts';
import { FLOW_KEY, loadFlow } from './neighborhood-activation.ts';
import { OUTCOMES_HANDLE, sign } from './outcomes.ts';

const PATH = '/api/webhooks/flowweb-crm';
const EMAIL = /^[^@\s<>"]+@[^@\s<>".]+(?:\.[^@\s<>".]+)+$/;
const ID = /^[A-Za-z0-9_-]{1,100}$/;

/** What Frequency last said about a draft's lead, as kept on the draft. */
export interface CrmState {
  status: 'synced' | 'off' | 'failed';
  at: string;
  lead_status?: string;
  signed_up?: boolean;
  conversation_url?: string;
  error?: string;
  /** The draft's marks when it was last synced, so an unchanged draft is not posted again the same day. */
  marks?: string;
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const s = (doc: Record<string, unknown>, k: string) =>
  typeof doc[k] === 'string' && doc[k] !== '' ? (doc[k] as string) : null;

/** The address a draft goes to, or null when it is not an email lead (a form, a social page, a template). */
export function leadEmail(doc: Record<string, unknown>): string | null {
  const to = s(doc, 'to') ?? s(doc, 'lead_id');
  return to && EMAIL.test(to) ? to.toLowerCase() : null;
}

const marksOf = (doc: Record<string, unknown>) =>
  ['sent_at', 'replied_at', 'declined_at'].map((k) => s(doc, k) ?? '').join('|');

/** The post for one draft, or null when the draft cannot be a CRM lead (no email, or rejected unsent). */
export function crmPayload(
  doc: Record<string, unknown>,
  huntName: string | null,
): Record<string, unknown> | null {
  const email = leadEmail(doc);
  if (!email || typeof doc.body !== 'string' || doc.body.trim() === '') return null;
  if (doc.status === 'rejected' && !s(doc, 'sent_at')) return null;
  const tag = s(doc, 'tag');
  if (!tag) return null;
  return {
    flow: s(doc, 'flow') ?? FLOW_KEY,
    lead: {
      email,
      name: s(doc, 'name'),
      org: s(doc, 'name'),
      source_url: s(doc, 'source_url'),
      region: s(doc, 'region'),
      hunt: huntName ?? s(doc, 'hunt_id'),
    },
    draft: {
      tag,
      subject: s(doc, 'subject'),
      body: doc.body,
      created_at: s(doc, 'created_at'),
      sent_at: s(doc, 'sent_at'),
      replied_at: s(doc, 'replied_at'),
      declined_at: s(doc, 'declined_at'),
    },
  };
}

/** True when a draft needs posting: never synced, its marks changed, or the last sync is a day old. */
export function needsSync(doc: Record<string, unknown>, now: Date): boolean {
  const c = isObj(doc.crm) ? doc.crm : null;
  if (c?.status !== 'synced') return true;
  if (c.marks !== marksOf(doc)) return true;
  if (c.lead_status === 'closed') return false;
  const at = typeof c.at === 'string' ? Date.parse(c.at) : Number.NaN;
  return !Number.isFinite(at) || now.getTime() - at >= 20 * 3_600_000;
}

function save(path: string, doc: Record<string, unknown>): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

interface Ctx {
  repoRoot: string;
  fwHome: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

function setup(o: Ctx): { site: string; secret: string } | { error: string; off?: boolean } {
  const flow = loadFlow(o.repoRoot, o.fwHome, o.now ?? new Date());
  if (!flow) return { error: `the ${FLOW_KEY} flow is not in this repo` };
  try {
    const secret = resolveCredential(OUTCOMES_HANDLE, { home: o.fwHome });
    return { site: (o.env?.FW_FREQUENCY_URL || flow.cfg.offer.url).replace(/\/$/, ''), secret };
  } catch (e) {
    return {
      error: `no secret for ${OUTCOMES_HANDLE}: ${e instanceof CredentialError ? e.message : e}`,
      off: true,
    };
  }
}

async function post(site: string, secret: string, body: string, now: Date): Promise<Record<string, unknown>> {
  const ts = String(Math.floor(now.getTime() / 1000));
  const res = await fetch(`${site}${PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-flowweb-timestamp': ts,
      'x-flowweb-signature': sign(secret, ts, body),
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const answer = (await res.json().catch(() => null)) as unknown;
  if (!res.ok || !isObj(answer)) throw new Error(`Frequency answered ${res.status}`);
  return answer;
}

/** Posts one draft (when it is an email lead) and writes Frequency's answer onto it. Never throws. */
export async function syncDraft(o: Ctx & { id: string }): Promise<CrmState | null> {
  if (!ID.test(o.id)) return null;
  const path = join(o.fwHome, 'flows', FLOW_KEY, 'drafts', `${o.id}.json`);
  if (!existsSync(path)) return null;
  const now = o.now ?? new Date();
  const cfg = setup({ ...o, now });
  const hunts = (() => {
    try {
      return loadHunts(o.fwHome);
    } catch {
      return [];
    }
  })();
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const hunt = hunts.find((h) => h.id === doc.hunt_id);
  const payload = crmPayload(doc, hunt?.name ?? null);
  if (!payload) return null;
  const at = now.toISOString();
  let state: CrmState;
  if ('error' in cfg) state = { status: cfg.off ? 'off' : 'failed', at, error: cfg.error };
  else {
    try {
      const a = await post(cfg.site, cfg.secret, JSON.stringify(payload), now);
      state =
        a.status === 'synced'
          ? {
              status: 'synced',
              at,
              marks: marksOf(doc),
              ...(typeof a.lead_status === 'string' ? { lead_status: a.lead_status } : {}),
              signed_up: a.signed_up === true,
              ...(typeof a.conversation_url === 'string' && /^https?:\/\//.test(a.conversation_url)
                ? { conversation_url: a.conversation_url }
                : {}),
            }
          : { status: 'off', at, error: `Frequency answered ${String(a.status)}` };
    } catch (e) {
      state = { status: 'failed', at, error: (e as Error)?.message ?? String(e) };
    }
  }
  // Re-read right before writing, so an edit or a mark made meanwhile is kept.
  try {
    const fresh = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    save(path, { ...fresh, crm: state });
  } catch {
    // The draft went away: nothing to record.
  }
  return state;
}

/** Posts every email draft whose state Frequency has not seen today. */
export async function syncAll(o: Ctx): Promise<{ synced: number; failed: number }> {
  const dir = join(o.fwHome, 'flows', FLOW_KEY, 'drafts');
  const now = o.now ?? new Date();
  const out = { synced: 0, failed: 0 };
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue;
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!crmPayload(doc, null) || !needsSync(doc, now)) continue;
    const r = await syncDraft({ ...o, now, id: f.slice(0, -5) });
    if (r?.status === 'synced') out.synced++;
    else if (r) out.failed++;
  }
  return out;
}
