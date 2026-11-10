// The changes the Owner may ask for from the hosted site, and how the relay applies them.
//
// The site stores a request (fw_requests); the relay on the Owner's machine takes it and calls the
// matching fwd route with the CLI token. Draft changes (edit, reject, AI rewrite, mark, approve), the
// flow controls (on, off, run now, the Draft or Copilot dial, Supervisor pause and resume), hunts and
// do-not-contact exist here (FW-C-062), and the morning run time and people a day (FW-C-063). A request can never set Autopilot, send anything, release the
// kill switch, or change a budget or a policy. Approving only hands a draft to the outbox; Core never
// sends. Pure functions, tested.

const FLOW = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DRAFT = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_FIELD = 20_000;
const MAX_INSTRUCTION = 2_000;

const ACTIONS = {
  edit: 'draft.edit',
  reject: 'draft.reject',
  rewrite: 'draft.rewrite',
  mark: 'draft.mark',
  approve: 'draft.approve',
};
const HUNT = /^hnt_[a-f0-9]{4,32}$/;
const HUNT_FIELDS = ['name', 'looking_for', 'region', 'areas', 'links', 'every_days', 'max_sends', 'build'];
/** The stops the site may set. Autopilot binds to a confirm hash and is set on the Owner's machine. */
const SITE_STOPS = ['draft', 'copilot'];
const OUTCOMES = ['sent', 'replied', 'declined'];

/**
 * The request a site call asks for, or null when the path is not a draft change.
 * Answers { error } for a draft change with bad input.
 */
export function draftRequestOf(method, path, body) {
  const m = /^\/supervisor\/flows\/([^/]+)\/drafts\/([^/]+)\/(edit|reject|rewrite|mark|approve)$/.exec(path);
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
  if (action === 'mark') {
    if (!OUTCOMES.includes(b.outcome)) return { error: `outcome must be one of ${OUTCOMES.join(', ')}` };
    payload.outcome = b.outcome;
  }
  return { kind: ACTIONS[action], flow, draft_id: draftId, payload };
}

/** The flow controls, by the last part of /supervisor/flows/{key}/<action>. */
const FLOW_ACTIONS = { enable: 'flow.enable', disable: 'flow.disable', run: 'flow.run', dial: 'flow.dial' };

const text = (v) => (typeof v === 'string' ? v.trim() : '');

/** FW-C-063: the morning run time and the people a day, checked the way fwd checks them. */
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const PER_DAY = (v) => Number.isInteger(v) && v >= 1 && v <= 25;
function tuningPayload(action, b) {
  if (action === 'schedule') {
    if (!TIME.test(String(b.time ?? ''))) return { error: 'time must be HH:MM' };
    if (b.days !== 'daily' && b.days !== 'weekdays') return { error: 'days must be daily or weekdays' };
    return { payload: { time: b.time, days: b.days } };
  }
  const min = b.min ?? 1;
  const max = b.max ?? 25;
  if (![b.per_day, min, max].every(PER_DAY)) return { error: 'leads per day must be a whole number from 1 to 25' };
  if (min > b.per_day || b.per_day > max) return { error: 'min must be at most per_day, and per_day at most max' };
  return { payload: { per_day: b.per_day, auto: b.auto === true, min, max } };
}

/** A hunt's fields as the Owner sent them, in their order; fwd checks the values. */
function huntPayload(b) {
  const payload = {};
  for (const [k, v] of Object.entries(b)) if (HUNT_FIELDS.includes(k)) payload[k] = v;
  if (!text(payload.name) || !text(payload.looking_for) || !text(payload.region))
    return { error: 'a hunt needs a name, what to look for and a region' };
  if (JSON.stringify(payload).length > MAX_FIELD) return { error: 'that hunt is too long' };
  return { payload };
}

/**
 * The request a site call asks for (FW-C-062): { kind, flow, draft_id, payload }, { error } for a
 * known control with bad input, or null when the path is not one the site may ask for.
 */
export function requestOf(method, path, body) {
  const b = body && typeof body === 'object' ? body : {};
  const drafted = draftRequestOf(method, path, b);
  if (drafted) return drafted;
  const sup = /^\/supervisor\/(pause|resume)$/.exec(path);
  if (sup) return method === 'POST' ? { kind: `supervisor.${sup[1]}`, flow: 'all', draft_id: null, payload: {} } : null;
  const tune = /^\/supervisor\/flows\/([^/]+)\/(schedule|intensity)$/.exec(path);
  if (tune) {
    if (method !== 'POST') return null;
    if (!FLOW.test(tune[1])) return { error: 'unknown flow' };
    const t = tuningPayload(tune[2], b);
    return t.error ? t : { kind: `flow.${tune[2]}`, flow: tune[1], draft_id: null, payload: t.payload };
  }
  const ctl = /^\/supervisor\/flows\/([^/]+)\/(enable|disable|run|dial)$/.exec(path);
  if (ctl) {
    const [, flow, action] = ctl;
    if (method !== 'POST') return null;
    if (!FLOW.test(flow)) return { error: 'unknown flow' };
    const payload = {};
    if (action === 'dial') {
      if (!SITE_STOPS.includes(b.stop))
        return {
          error:
            b.stop === 'autopilot'
              ? 'Autopilot is set on your Mac: fw supervisor dial <flow> autopilot'
              : 'stop must be draft or copilot',
        };
      payload.stop = b.stop;
    }
    return { kind: FLOW_ACTIONS[action], flow, draft_id: null, payload };
  }
  const hunts = /^\/flows\/([^/]+)\/hunts(?:\/([^/]+)(\/run)?)?$/.exec(path);
  if (hunts) {
    const [, flow, id, run] = hunts;
    if (!FLOW.test(flow)) return { error: 'unknown flow' };
    if (!id) {
      if (method !== 'POST') return null;
      const h = huntPayload(b);
      return h.error ? h : { kind: 'hunt.save', flow, draft_id: null, payload: h.payload };
    }
    if (!HUNT.test(id)) return { error: 'unknown hunt' };
    if (run) return method === 'POST' ? { kind: 'hunt.run', flow, draft_id: id, payload: {} } : null;
    return method === 'DELETE' ? { kind: 'hunt.remove', flow, draft_id: id, payload: {} } : null;
  }
  const block = /^\/flows\/([^/]+)\/do-not-contact$/.exec(path);
  if (block) {
    if (method !== 'POST') return null;
    if (!FLOW.test(block[1])) return { error: 'unknown flow' };
    const reason = text(b.reason);
    const email = text(b.email);
    const lead = text(b.lead_id);
    if (!reason) return { error: 'give a reason' };
    if (!email && !lead) return { error: 'give an email address, an @domain or a lead' };
    if (reason.length > MAX_INSTRUCTION || email.length > 320 || lead.length > 200)
      return { error: 'that is too long' };
    const payload = email ? { email, reason } : { lead_id: lead, reason };
    return { kind: 'flow.block', flow: block[1], draft_id: null, payload };
  }
  return null;
}

/**
 * FW-C-071: a site move of the dial to Copilot or Autopilot needs a sender on the Owner's Mac to read the
 * outbox. sender is fwd's { installed, last_pass_at } from GET /v1/status. Answers why the relay holds the
 * request, or null when it may go on. An unknown sender holds it too.
 */
export function senderHold(req, sender) {
  if (String(req?.kind ?? '') !== 'flow.dial') return null;
  const stop = req?.payload && typeof req.payload === 'object' ? req.payload.stop : undefined;
  if (stop !== 'copilot' && stop !== 'autopilot') return null;
  if (sender?.installed === true) return null;
  return 'Needs a sender on your Mac: Copilot and Autopilot hand drafts to it, and none has run in the last day. Set one up from senders/README.md, or stay on Draft and copy each draft.';
}

/** The fwd call ({ method, path, body }) for a request the relay took, or null for anything not on the list. */
export function fwdCallFor(req) {
  const kind = String(req?.kind ?? '');
  const flow = String(req?.flow ?? '');
  const p = req?.payload && typeof req.payload === 'object' ? req.payload : {};
  const f = encodeURIComponent(flow);
  if (kind === 'supervisor.pause' || kind === 'supervisor.resume')
    return { method: 'POST', path: `/supervisor/${kind.slice(11)}`, body: {} };
  if (!FLOW.test(flow)) return null;
  const control = Object.entries(FLOW_ACTIONS).find(([, k]) => k === kind)?.[0];
  if (control) {
    if (control !== 'dial') return { method: 'POST', path: `/supervisor/flows/${f}/${control}`, body: {} };
    return SITE_STOPS.includes(p.stop)
      ? { method: 'POST', path: `/supervisor/flows/${f}/dial`, body: { stop: p.stop } }
      : null;
  }
  if (kind === 'flow.schedule' || kind === 'flow.intensity') {
    const action = kind.slice(5);
    const t = tuningPayload(action, p);
    return t.error ? null : { method: 'POST', path: `/supervisor/flows/${f}/${action}`, body: t.payload };
  }
  if (kind === 'hunt.save') {
    const h = huntPayload(p);
    return h.error ? null : { method: 'POST', path: `/flows/${f}/hunts`, body: h.payload };
  }
  if (kind === 'hunt.run' || kind === 'hunt.remove') {
    const id = String(req.draft_id ?? '');
    if (!HUNT.test(id)) return null;
    return kind === 'hunt.run'
      ? { method: 'POST', path: `/flows/${f}/hunts/${id}/run`, body: {} }
      : { method: 'DELETE', path: `/flows/${f}/hunts/${id}`, body: undefined };
  }
  if (kind === 'flow.block') {
    const asked = requestOf('POST', `/flows/${flow}/do-not-contact`, p);
    return asked && !asked.error ? { method: 'POST', path: `/flows/${f}/do-not-contact`, body: asked.payload } : null;
  }
  const action = Object.entries(ACTIONS).find(([, k]) => k === kind)?.[0];
  if (!action || !DRAFT.test(String(req.draft_id))) return null;
  const body =
    action === 'edit'
      ? Object.fromEntries(['subject', 'body'].filter((x) => typeof p[x] === 'string').map((x) => [x, p[x]]))
      : action === 'rewrite'
        ? {
            instruction: String(p.instruction ?? ''),
            ...Object.fromEntries(['subject', 'body'].filter((x) => typeof p[x] === 'string').map((x) => [x, p[x]])),
          }
        : action === 'mark'
          ? OUTCOMES.includes(p.outcome)
            ? { outcome: p.outcome }
            : null
          : {};
  if (!body) return null;
  return {
    method: 'POST',
    path: `/supervisor/flows/${f}/drafts/${encodeURIComponent(req.draft_id)}/${action}`,
    body,
  };
}
