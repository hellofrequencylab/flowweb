// FW-C-115: one do-not-contact view for every flow. A person on the list never gets a draft offered,
// approved or batch-approved, and an opt-out (a pasted "no", host.opted_out) takes that person's waiting
// drafts in every flow out of waiting_for_owner the same day (status do_not_contact). Drafts are kept.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { onList } from './draft-gate.ts';

/** The flow that keeps the shared list (creator outreach); host-moments writes its opt-outs there too. */
export const SHARED_DNC_FLOW = 'neighborhood-activation';

type Doc = Record<string, unknown>;
const text = (d: Doc, k: string) => (typeof d[k] === 'string' && d[k] !== '' ? (d[k] as string) : null);
const readJson = (p: string): unknown => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

/** The do-not-contact entries for a flow: its own state.json list and the shared one. */
export function doNotContactList(fwHome: string, flow: string): string[] {
  const out = new Set<string>();
  for (const f of new Set([flow, SHARED_DNC_FLOW])) {
    const s = readJson(join(fwHome, 'flows', f, 'state.json')) as Doc | null;
    const list = Array.isArray(s?.do_not_contact) ? (s.do_not_contact as unknown[]) : [];
    for (const x of list) if (String(x).trim()) out.add(String(x).trim().toLowerCase());
  }
  return [...out];
}

/** The entry that matches this draft's person (address, page, lead, sequence lead or host), or null. */
export function dncMatch(list: string[], d: Doc): string | null {
  if (list.length === 0) return null;
  const host = text(d, 'host_id');
  const lead = text(d, 'lead_id');
  const leads = [
    lead,
    text(d, 'sequence_lead'),
    host ? `frequency-host:${host}` : null,
    lead?.startsWith('host:') ? `frequency-host:${lead.slice(5)}` : null,
  ];
  const first = onList(list, { body: '', to: text(d, 'to'), contact_url: text(d, 'contact_url') });
  if (first) return first;
  for (const l of leads) {
    const hit = l ? onList(list, { body: '', lead_id: l }) : null;
    if (hit) return hit;
  }
  return null;
}

/**
 * Moves every waiting draft, in every flow, whose person matches one of keys to status do_not_contact.
 * Answers the ids moved as flow/id.
 */
export function retireDrafts(fwHome: string, keys: string[], at: string): string[] {
  const list = keys.map((k) => k.trim().toLowerCase()).filter(Boolean);
  const flows = join(fwHome, 'flows');
  if (list.length === 0 || !existsSync(flows)) return [];
  const moved: string[] = [];
  for (const flow of readdirSync(flows)) {
    const dir = join(flows, flow, 'drafts');
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const p = join(dir, f);
      const d = readJson(p) as Doc | null;
      if (!d || d.status !== 'waiting_for_owner') continue;
      const hit = dncMatch(list, d);
      if (!hit) continue;
      const next = { ...d, status: 'do_not_contact', held: 'opted_out', do_not_contact: { at, entry: hit } };
      writeFileSync(`${p}.tmp`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      renameSync(`${p}.tmp`, p);
      moved.push(`${flow}/${String(d.id ?? f.slice(0, -5))}`);
    }
  }
  return moved;
}
