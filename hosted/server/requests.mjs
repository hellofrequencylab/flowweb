// The changes the Owner may ask for from the hosted site, and how the relay applies them.
//
// The site stores a request (fw_requests); the relay on the Owner's machine takes it and calls the
// matching fwd route with the CLI token. Draft changes (edit, reject, AI rewrite, mark, approve), the
// flow controls (on, off, run now, the Draft or Copilot dial, Supervisor pause and resume, and from FW-C-115
// rename, note, archive and restore), hunts and
// do-not-contact exist here (FW-C-062), the morning run time and people a day (FW-C-063), and from FW-C-118
// the switch for links to Frequency's funnel pages (links.funnels). A request can never set Autopilot, send anything, release the
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
const SKIP_REASONS = ['wrong_niche', 'not_local', 'not_a_fit', 'on_frequency'];
/** FW-C-095: the email sender's settings, checked as fwd and senders/email.mjs check them. Never a password. */
const SENDER_SECRET = /password|secret|token|^pass$/i;
const SENDER_BOX = /^[a-z][a-z0-9_]{0,19}$/;
const SENDER_ADDRESS = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/;
const whole = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
function senderPayload(b) {
  if (Object.keys(b).some((k) => SENDER_SECRET.test(k))) return { error: 'passwords stay in the keychain' };
  const boxes = Array.isArray(b.mailboxes) ? b.mailboxes : [];
  if (boxes.length < 1 || boxes.length > 3) return { error: 'give one to three mailboxes' };
  const mailboxes = [];
  for (const m of boxes) {
    const x = m && typeof m === 'object' ? m : {};
    if (Object.keys(x).some((k) => SENDER_SECRET.test(k))) return { error: 'passwords stay in the keychain' };
    const key = typeof x.key === 'string' ? x.key : '';
    const address = typeof x.address === 'string' ? x.address.trim() : '';
    const name = typeof x.name === 'string' ? x.name.trim().slice(0, 100) : '';
    if (!SENDER_BOX.test(key) || mailboxes.some((y) => y.key === key)) return { error: 'bad or repeated mailbox key' };
    if (!SENDER_ADDRESS.test(address)) return { error: 'a mailbox needs an email address' };
    mailboxes.push({ key, address, name });
  }
  const postal = typeof b.postal === 'string' ? b.postal.trim() : '';
  if (!postal || postal.length > 300) return { error: 'a postal address is required' };
  if (!whole(b.daily_cap, 1, 40) || !whole(b.per_pass, 1, 5)) return { error: 'daily_cap is 1 to 40, per_pass 1 to 5' };
  const h = b.hours && typeof b.hours === 'object' ? b.hours : {};
  if (!whole(h.start, 0, 23) || !whole(h.end, 1, 24) || h.end <= h.start) return { error: 'bad sending hours' };
  const days = Array.isArray(h.days) ? h.days : [];
  if (days.length === 0 || !days.every((d) => whole(d, 0, 6))) return { error: 'pick at least one day' };
  const hours = { start: h.start, end: h.end, days: [...new Set(days)].sort((x, y) => x - y) };
  return { payload: { mailboxes, postal, daily_cap: b.daily_cap, per_pass: b.per_pass, hours } };
}

/** FW-C-087: a project's brief (the five answers) and its labels, from Settings. */
const PROJECT = /^[A-Za-z0-9_-]{1,100}$/;
const BRIEF_KEYS = ['what', 'who', 'voice', 'never', 'done'];
const BRIEF_MAX = 1000;
const LABEL_MAX = 64;
function projectPayload(action, b) {
  if (action === 'brief') {
    const payload = {};
    for (const k of BRIEF_KEYS) {
      const v = text(b[k]);
      if (!v) return { error: `the brief needs an answer for ${k}` };
      if (v.length > BRIEF_MAX) return { error: `${k} is at most ${BRIEF_MAX} characters` };
      payload[k] = v;
    }
    return { payload };
  }
  const payload = {};
  for (const k of ['brand', 'category']) {
    if (b[k] === undefined) continue;
    if (b[k] !== null && typeof b[k] !== 'string') return { error: `${k} must be text` };
    const v = b[k] === null ? null : b[k].trim();
    if (v && v.length > LABEL_MAX) return { error: `${k} is at most ${LABEL_MAX} characters` };
    payload[k] = v || null;
  }
  if (Object.keys(payload).length === 0) return { error: 'give a brand, a category or both' };
  return { payload };
}

/** FW-C-118: funnel links on, off, or null to hand the choice back to the Mac's env var and flow configs. */
const FUNNELS = [true, false, null];
// FW-C-123: an agent's name (up to 40) or voice (up to 200); null restores the default.
const TEAM_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
function teamPayload(p) {
  if (!TEAM_KEY.test(String(p.team ?? '')) || !TEAM_KEY.test(String(p.role ?? ''))) return { error: 'unknown team or agent' };
  const payload = { team: p.team, role: p.role };
  for (const [f, max] of [['name', 40], ['voice', 200]]) {
    if (!(f in p)) continue;
    const v = p[f];
    if (v !== null && (typeof v !== 'string' || !v.trim() || v.trim().length > max))
      return { error: `${f} must be text of 1 to ${max} characters, or null` };
    payload[f] = v === null ? null : v.trim();
  }
  if (!('name' in payload) && !('voice' in payload)) return { error: 'send name or voice' };
  return { payload };
}

/** FW-C-086: the AI accounts a flow may use. Only which one; the key stays on the Owner's machine. */
const AI_ACCOUNTS = ['claude_plan', 'anthropic_key', 'chatgpt_plan', 'openai_key'];

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
  // FW-C-105: a skip from Today carries its reason to fwd.
  if (action === 'reject' && b.reason !== undefined) {
    if (!SKIP_REASONS.includes(b.reason)) return { error: `reason must be one of ${SKIP_REASONS.join(', ')}` };
    payload.reason = b.reason;
  }
  return { kind: ACTIONS[action], flow, draft_id: draftId, payload };
}

/** The flow controls, by the last part of /supervisor/flows/{key}/<action>. */
const FLOW_ACTIONS = { enable: 'flow.enable', disable: 'flow.disable', run: 'flow.run', dial: 'flow.dial' };

const text = (v) => (typeof v === 'string' ? v.trim() : '');

/** FW-C-115: a flow's name and note, checked as fwd checks them; null or '' clears one. */
const FLOW_NAME_MAX = 80;
const FLOW_NOTE_MAX = 500;
function editPayload(b) {
  const payload = {};
  for (const [k, max] of [
    ['name', FLOW_NAME_MAX],
    ['note', FLOW_NOTE_MAX],
  ]) {
    if (!(k in b)) continue;
    if (b[k] === null || b[k] === '') payload[k] = null;
    else {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this strips.
      const v = typeof b[k] === 'string' ? b[k].replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : '';
      if (!v || v.length > max) return { error: `${k} must be text of 1 to ${max} characters` };
      payload[k] = v;
    }
  }
  return Object.keys(payload).length ? { payload } : { error: 'give a name or a note' };
}

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
  if (path === '/supervisor/funnels-live') {
    if (method !== 'POST') return null;
    if (!FUNNELS.includes(b.live)) return { error: 'live must be true, false or null' };
    return { kind: 'links.funnels', flow: 'all', draft_id: null, payload: { live: b.live } };
  }
  const team = /^\/team\/([^/]+)\/([^/]+)$/.exec(path);
  if (team) {
    if (method !== 'POST') return null;
    const t = teamPayload({ team: team[1], role: team[2], ...pick(b, ['name', 'voice']) });
    return t.error ? t : { kind: 'team.edit', flow: 'all', draft_id: null, payload: t.payload };
  }
  if (path === '/connections/email') {
    if (method !== 'POST') return null;
    const sp = senderPayload(b);
    return sp.error ? sp : { kind: 'connection.email', flow: 'all', draft_id: null, payload: sp.payload };
  }
  const proj = /^\/projects\/([^/]+)\/(brief|labels)$/.exec(path);
  if (proj) {
    if (method !== 'POST') return null;
    if (!PROJECT.test(proj[1])) return { error: 'unknown project' };
    const p = projectPayload(proj[2], b);
    return p.error ? p : { kind: `project.${proj[2]}`, flow: 'all', draft_id: proj[1], payload: p.payload };
  }
  const admin = /^\/supervisor\/flows\/([^/]+)\/(edit|archive|restore)$/.exec(path);
  if (admin) {
    if (method !== 'POST') return null;
    if (!FLOW.test(admin[1])) return { error: 'unknown flow' };
    if (admin[2] !== 'edit') return { kind: `flow.${admin[2]}`, flow: admin[1], draft_id: null, payload: {} };
    const e = editPayload(b);
    return e.error ? e : { kind: 'flow.edit', flow: admin[1], draft_id: null, payload: e.payload };
  }
  const ai = /^\/supervisor\/flows\/([^/]+)\/ai$/.exec(path);
  if (ai) {
    if (method !== 'POST') return null;
    if (!FLOW.test(ai[1])) return { error: 'unknown flow' };
    if (!AI_ACCOUNTS.includes(b.account)) return { error: `account must be one of ${AI_ACCOUNTS.join(', ')}` };
    return { kind: 'flow.ai', flow: ai[1], draft_id: null, payload: { account: b.account } };
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
  if (kind === 'links.funnels')
    return FUNNELS.includes(p.live) ? { method: 'POST', path: '/supervisor/funnels-live', body: { live: p.live } } : null;
  if (kind === 'team.edit') {
    const t = teamPayload(p);
    if (t.error) return null;
    const { team, role, ...body } = t.payload;
    return { method: 'POST', path: `/team/${team}/${role}`, body };
  }
  if (kind === 'connection.email') {
    const sp = senderPayload(p);
    return sp.error ? null : { method: 'POST', path: '/connections/email', body: sp.payload };
  }
  if (kind === 'project.brief' || kind === 'project.labels') {
    const id = String(req?.draft_id ?? '');
    const action = kind.slice(8);
    const pp = projectPayload(action, p);
    return PROJECT.test(id) && !pp.error
      ? { method: 'POST', path: `/projects/${encodeURIComponent(id)}/${action}`, body: pp.payload }
      : null;
  }
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
  if (kind === 'flow.archive' || kind === 'flow.restore')
    return { method: 'POST', path: `/supervisor/flows/${f}/${kind.slice(5)}`, body: {} };
  if (kind === 'flow.edit') {
    const e = editPayload(p);
    return e.error ? null : { method: 'POST', path: `/supervisor/flows/${f}/edit`, body: e.payload };
  }
  if (kind === 'flow.ai')
    return AI_ACCOUNTS.includes(p.account)
      ? { method: 'POST', path: `/supervisor/flows/${f}/ai`, body: { account: p.account } }
      : null;
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
          : action === 'reject' && SKIP_REASONS.includes(p.reason)
            ? { reason: p.reason }
            : {};
  if (!body) return null;
  return {
    method: 'POST',
    path: `/supervisor/flows/${f}/drafts/${encodeURIComponent(req.draft_id)}/${action}`,
    body,
  };
}
