// The changes the Owner may ask for from the hosted site, and how the relay applies them.
//
// The site stores a request (fw_requests); the relay on the Owner's machine takes it and calls the
// matching fwd route with the CLI token. Only draft edits, rejects and AI rewrites exist here: a
// request can never approve, send, or change a flow, a budget or a policy. Pure functions, tested.

const FLOW = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DRAFT = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_FIELD = 20_000;
const MAX_INSTRUCTION = 2_000;

const ACTIONS = { edit: 'draft.edit', reject: 'draft.reject', rewrite: 'draft.rewrite' };

/**
 * The request a site call asks for, or null when the path is not a draft change.
 * Answers { error } for a draft change with bad input.
 */
export function draftRequestOf(method, path, body) {
  const m = /^\/supervisor\/flows\/([^/]+)\/drafts\/([^/]+)\/(edit|reject|rewrite)$/.exec(path);
  if (!m || method !== 'POST') return null;
  const [, flow, draftId, action] = m;
  if (!FLOW.test(flow) || !DRAFT.test(draftId)) return { error: 'unknown flow or draft' };
  const b = body && typeof body === 'object' ? body : {};
  const payload = {};
  if (action === 'edit') {
    for (const f of ['subject', 'body']) {
      if (b[f] === undefined) continue;
      if (typeof b[f] !== 'string') return { error: `${f} must be text` };
      if (b[f].length > MAX_FIELD) return { error: `${f} is longer than ${MAX_FIELD} characters` };
      payload[f] = b[f];
    }
    if (Object.keys(payload).length === 0) return { error: 'give a subject, a body or both' };
    if (payload.body !== undefined && payload.body.trim() === '') return { error: 'body cannot be empty' };
  }
  if (action === 'rewrite') {
    const i = typeof b.instruction === 'string' ? b.instruction.trim() : '';
    if (i === '') return { error: 'say how to rewrite it' };
    if (i.length > MAX_INSTRUCTION) return { error: `the instruction is longer than ${MAX_INSTRUCTION} characters` };
    payload.instruction = i;
    // The editor's unsaved text, when the Owner is mid-edit: that is what gets rewritten.
    for (const f of ['subject', 'body']) {
      if (typeof b[f] !== 'string') continue;
      if (b[f].length > MAX_FIELD) return { error: `${f} is longer than ${MAX_FIELD} characters` };
      payload[f] = b[f];
    }
  }
  return { kind: ACTIONS[action], flow, draft_id: draftId, payload };
}

/** The fwd call for a request the relay took, or null for anything not on the list. */
export function fwdCallFor(req) {
  const action = Object.entries(ACTIONS).find(([, k]) => k === req?.kind)?.[0];
  if (!action || !FLOW.test(String(req.flow)) || !DRAFT.test(String(req.draft_id))) return null;
  const p = req.payload && typeof req.payload === 'object' ? req.payload : {};
  const body =
    action === 'edit'
      ? Object.fromEntries(['subject', 'body'].filter((f) => typeof p[f] === 'string').map((f) => [f, p[f]]))
      : action === 'rewrite'
        ? {
            instruction: String(p.instruction ?? ''),
            ...Object.fromEntries(['subject', 'body'].filter((f) => typeof p[f] === 'string').map((f) => [f, p[f]])),
          }
        : {};
  return {
    path: `/supervisor/flows/${encodeURIComponent(req.flow)}/drafts/${encodeURIComponent(req.draft_id)}/${action}`,
    body,
  };
}
