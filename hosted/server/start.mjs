// FW-C-124: the first run on flowweb.app. The Owner types one sentence on /start and gets back a node: a name,
// the goal in their words, the flow that does it, and the steps that flow takes, each opening to what it needs.
// A second sentence grows the same node. Rules that never bend:
//   - The model only picks a flow and names the node, through one tool. The steps come from code (STEPS), so
//     what a node says it will do is what the flow does.
//   - The node is a proposal. "Make it a draft flow" sends the same copy request the Flows page would, and the
//     copy starts off, on Draft. Nothing sends, posts or spends.
//   - When no flow fits, the node offers a build request instead (FW-C-112), never a made-up flow.
//   - A viewer gets the node and nothing to make. A key-shaped prompt is refused before any call. Nothing is
//     stored or logged.
// Pure apart from the injected fetch, so it is tested without a network.
import { apiDetail, isSignInToken, refusalReason, retryWithoutBeta, SIGN_IN_TOKEN, siteKey, workspaceHeaders } from './site-key.mjs';
import { ASSISTANT_MODEL, looksLikeSecret } from './assistant.mjs';
import { buildRequestOf } from './console.mjs';

const MAX_PROMPT = 2000;
const NAME_MAX = 80;
const NOTE_MAX = 500;
const MAKE_ROLES = new Set(['owner', 'admin']);

const approval = { kind: 'approval', label: 'You approve every message' };

/** What each copyable flow does, in order. A step's needs is what the Owner has to give before it can run. */
export const STEPS = {
  'neighborhood-activation': [
    { id: 'find', label: 'Find people', detail: 'Finds hosts, venues and neighbors in the area you pick.', needs: null },
    { id: 'route', label: 'Pick the right page', detail: 'Matches each person to the page that fits them best.', needs: null },
    { id: 'draft', label: 'Draft messages', detail: 'Writes a short, warm message for each person.', needs: null },
    { id: 'check', label: 'You check each one', detail: 'Nothing goes out until you say yes.', needs: approval },
    {
      id: 'send',
      label: 'Send',
      detail: 'Sends only what you approved, from your own email.',
      needs: { kind: 'sender', label: 'Connect your email to send' },
    },
    { id: 'follow', label: 'Follow up', detail: 'Drafts an answer when someone replies. You check that too.', needs: null },
  ],
  'paid-ads': [
    { id: 'numbers', label: 'Bring in your ad numbers', detail: 'Reads the daily report you drop in from your ad account.', needs: null },
    { id: 'add', label: 'Add them up', detail: 'Totals clicks, spend and sign-ups, and what each sign-up cost.', needs: null },
    {
      id: 'cap',
      label: 'Set what a sign-up may cost',
      detail: 'Your target cost per sign-up, and the most you will spend.',
      needs: { kind: 'cap', label: 'Set your spend cap' },
    },
    { id: 'move', label: 'Name one next move', detail: 'Suggests one change to the campaign, with the numbers behind it.', needs: null },
    {
      id: 'decide',
      label: 'You decide',
      detail: 'It never touches the campaign. You make any change yourself.',
      needs: { kind: 'approval', label: 'You make every change' },
    },
  ],
};

const FLOWS = Object.keys(STEPS);

export const START_TOOL = {
  name: 'propose_node',
  description: 'Turn what the person asked for into one node: pick the flow that does it, or none, and name it.',
  input_schema: {
    type: 'object',
    properties: {
      base: {
        type: 'string',
        enum: [...FLOWS, 'none'],
        description: 'The flow that does this, or none when no flow here does.',
      },
      name: { type: 'string', description: 'A short name for this, up to 60 characters, in their words.' },
      goal: { type: 'string', description: 'One sentence: what they want to happen, in their words.' },
      why: { type: 'string', description: 'One plain sentence on why this flow fits, or what is missing when none does.' },
    },
    required: ['base', 'name', 'goal', 'why'],
  },
};

export const START_PROMPT = `You turn one sentence from a small business owner into a node in FlowWeb. FlowWeb runs flows: each one finds or reads something, drafts the work, and the owner checks it before anything goes out. These are the flows that exist:
- neighborhood-activation: finds local people (hosts, venues, teachers, neighbors, builders) in an area, drafts a short invite or message for each, the owner approves each one, then it sends from their email and drafts follow-ups. Use it for any outreach to find, invite or recruit people locally.
- paid-ads: reads the daily numbers of one ad campaign, adds up what each sign-up cost, and names one next move. It never changes the campaign. Use it when they want to watch or improve an ad campaign.
- none: anything else (payroll, bookkeeping, scheduling staff, a website, social posting, anything these two do not do).
Call propose_node once. Do not stretch a flow to fit; say none when it does not fit. Name and goal use their words. Plain English, no em dashes.`;

const bad = (status, code, message) => ({ status, body: { error: { code, message } } });

/** Text without control characters or long dashes, cut to n. */
function clean(v, n) {
  const s = typeof v === 'string' ? v : '';
  return s
    .replace(/\s*[–—]\s*/g, ', ')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this strips.
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n)
    .trim();
}

/** The node the page shows, from the model's answer. */
export function nodeOf(input, { prompt, canMake }) {
  const i = input && typeof input === 'object' ? input : {};
  const base = FLOWS.includes(i.base) ? i.base : null;
  const name = clean(i.name, 60) || clean(prompt, 60) || 'New flow';
  const goal = clean(i.goal, 300) || clean(prompt, 300);
  const why = clean(i.why, 300);
  const ask = base
    ? null
    : buildRequestOf({
        title: clean(`${name} flow`, 120),
        what: clean(`${goal}. Asked on the first run as: ${prompt}`, 4000),
        done_when: `A ${name} flow drafts its work for my approval, and nothing goes out until I say yes.`.slice(0, 1000),
      });
  return {
    name,
    goal,
    why,
    base,
    dial: 'draft',
    steps: base ? STEPS[base] : [],
    copy:
      base && canMake
        ? {
            method: 'POST',
            path: `/supervisor/flows/${base}/copy`,
            body: { name: name.slice(0, NAME_MAX), note: goal.slice(0, NOTE_MAX) },
          }
        : null,
    build_request: canMake ? ask : null,
  };
}

/**
 * Answers { status, body }. body is { prompt, previous? }, previous the node being grown ({ name, goal, base }).
 * `env` holds FW_ASSISTANT_ANTHROPIC_KEY; `fetchImpl` is the network; `role` is the person's in this business.
 */
export async function nodeFromPrompt(body, { env = {}, fetchImpl = fetch, role = 'viewer' } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : '';
  if (!prompt) return bad(400, 'validation_failed', 'Say what your business should do.');
  if (prompt.length > MAX_PROMPT) return bad(400, 'validation_failed', `Keep it under ${MAX_PROMPT} characters.`);
  if (looksLikeSecret(prompt))
    return bad(400, 'looks_like_secret', 'That looks like a key, so it was not sent. Paste keys only into your terminal when a command asks.');
  const key = siteKey(env);
  if (key && isSignInToken(key)) return bad(500, 'upstream_failed', SIGN_IN_TOKEN);
  if (!key) return bad(503, 'not_configured', 'This site has no AI yet.');

  const p = b.previous && typeof b.previous === 'object' ? b.previous : null;
  const before = p
    ? `They already have this node: name "${clean(p.name, 80)}", goal "${clean(p.goal, 300)}", flow ${FLOWS.includes(p.base) ? p.base : 'none'}. They are adding to it, so keep its flow unless what they add clearly needs another, and fold the addition into the goal.\n\n`
    : '';
  const canMake = MAKE_ROLES.has(role);

  const call = (withFallback) =>
    fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        ...workspaceHeaders(env, key),
        'anthropic-version': '2023-06-01',
        ...(withFallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: ASSISTANT_MODEL,
        max_tokens: 1000,
        output_config: { effort: 'low' },
        ...(withFallback ? { fallbacks: 'default' } : {}),
        system: START_PROMPT,
        tools: [START_TOOL],
        tool_choice: { type: 'tool', name: START_TOOL.name },
        messages: [{ role: 'user', content: `${before}What they want: ${prompt}` }],
      }),
    });
  let res;
  try {
    res = await call(true);
    if (retryWithoutBeta(res.status)) res = await call(false);
  } catch {
    return bad(502, 'unreachable', 'Could not reach the AI.');
  }
  if (!res.ok) {
    const e = (await res.json().catch(() => null))?.error;
    const type = e?.type ?? 'unknown';
    console.warn(`start: Anthropic API answered ${res.status} (${type}) ${apiDetail(e?.message)}`);
    return bad(500, 'upstream_failed', refusalReason(res.status, type, 'Could not make that just now.', e?.message));
  }
  const msg = await res.json().catch(() => null);
  const use = (Array.isArray(msg?.content) ? msg.content : []).find((c) => c?.type === 'tool_use' && c.name === START_TOOL.name);
  if (!use) return bad(500, 'no_answer', 'Could not make that. Try saying it another way.');
  const node = nodeOf(use.input, { prompt, canMake });
  if (looksLikeSecret(JSON.stringify(node))) return bad(500, 'no_answer', 'Could not make that. Try saying it another way.');
  return {
    status: 200,
    body: { data: { node, can_make: canMake }, as_of: new Date().toISOString(), head_seq: null, next_cursor: null },
  };
}
