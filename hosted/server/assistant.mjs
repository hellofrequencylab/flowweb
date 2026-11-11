// FW-C-085: the setup assistant's answers on the live site.
//
// A signed-in person asks a setup question; this answers it with Claude, using FlowWeb's own key from
// the site's environment (FW_ASSISTANT_ANTHROPIC_KEY). Rules that never bend:
//   - A question that looks like a key, token or password is refused here too, before any call, and is
//     never forwarded, stored or logged. The page refuses it first; this is the second lock.
//   - Nothing is stored: no question, no answer, no log line with either.
//   - Without the key the site answers 503 not_configured and the page uses its built-in answers.
// Pure apart from the injected fetch, so it is tested without a network.

import { apiDetail, isSignInToken, refusalReason, retryWithoutBeta, SIGN_IN_TOKEN, siteKey, workspaceHeaders } from './site-key.mjs';

const MAX_QUESTION = 1000;
const STAGES = ['machine', 'ai', 'fix_ai', 'next_steps', 'done'];
export const ASSISTANT_MODEL = 'claude-opus-5-5';

/** The same shapes the page refuses (packages/web/src/setup/assistant.ts), kept in step by the probe. */
const SECRET_SHAPES = [
  /sk-ant-[A-Za-z0-9_-]{8,}/,
  /sk-(proj|svcacct|admin)?-?[A-Za-z0-9_-]{16,}/,
  /fwr_[A-Za-z0-9_-]{8,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /xox[abprs]-[A-Za-z0-9-]{10,}/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function looksLikeSecret(text) {
  if (/^[a-z]{4} ?[a-z]{4} ?[a-z]{4} ?[a-z]{4}$/.test(String(text).trim())) return true;
  if (SECRET_SHAPES.some((re) => re.test(text))) return true;
  for (const word of String(text).split(/\s+/)) {
    if (word.length < 32 || /^https?:\/\//i.test(word)) continue;
    if (/^[A-Za-z0-9_\-+/=.]+$/.test(word) && /[0-9]/.test(word) && /[A-Za-z]/.test(word)) return true;
  }
  return false;
}

export const SYSTEM_PROMPT = `You are the FlowWeb setup assistant on flowweb.app. You help one person set up FlowWeb and connect their own AI account. Answer in plain, friendly English in at most 120 words. Do not use em dashes.

How FlowWeb works:
- FlowWeb runs on the person's own Mac or Linux machine that stays on (the daemon is called fwd). flowweb.app is a mirror: a small relay on their machine pushes what FlowWeb sees, every minute. Nothing on their machine is opened to the internet.
- Install: git clone https://github.com/hellofrequencylab/flowweb.git ~/flowweb, cd ~/flowweb, pnpm install, pnpm fwd. Then Settings on the site, Add a machine, and run the command it shows once, in the FlowWeb folder.
- AI accounts are connected on their machine with: pnpm fw accounts connect (add --only claude or --only codex for one). It signs in a Claude Pro or Max plan (needs the Claude Code app: npm install -g @anthropic-ai/claude-code, then it runs claude setup-token) or a ChatGPT plan (needs the Codex app: npm install -g @openai/codex, then codex login), and can store an Anthropic or OpenAI API key instead. Tokens and keys go into the machine's keychain (macOS Keychain, or secret-tool on Linux, or a private file in ~/.flowweb/creds). pnpm fw accounts check makes one tiny real call per account; the result shows on the site.
- A plan they already pay for costs nothing extra. API keys bill per use.
- Windows is not supported yet.

Rules:
- Never ask for, accept or repeat a key, token or password. If they offer one, tell them to paste it only into their terminal when the command asks.
- Only answer questions about setting up and using FlowWeb. For anything else, say you can only help with FlowWeb setup.
- If you do not know, say so and suggest pnpm fw doctor or pnpm fw accounts check.`;

/**
 * Answers { status, body }. `env` holds FW_ASSISTANT_ANTHROPIC_KEY; `fetchImpl` is the network.
 */
export async function answerSetupQuestion(body, { env = {}, fetchImpl = fetch } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const question = typeof b.question === 'string' ? b.question.trim() : '';
  if (!question) return { status: 400, body: { error: { code: 'validation_failed', message: 'Ask a question.' } } };
  if (question.length > MAX_QUESTION)
    return {
      status: 400,
      body: { error: { code: 'validation_failed', message: `Keep it under ${MAX_QUESTION} characters.` } },
    };
  if (looksLikeSecret(question))
    return {
      status: 400,
      body: {
        error: {
          code: 'looks_like_secret',
          message: "That looks like a key, so it was not sent. Paste keys only into your terminal when the command asks.",
        },
      },
    };
  const key = siteKey(env);
  if (key && isSignInToken(key))
    return { status: 500, body: { error: { code: 'upstream_failed', message: SIGN_IN_TOKEN } } };
  if (!key)
    return {
      status: 503,
      body: { error: { code: 'not_configured', message: 'The setup assistant has no AI on this site yet.' } },
    };
  const stage = STAGES.includes(b.stage) ? b.stage : 'unknown';
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
        max_tokens: 2000,
        output_config: { effort: 'low' },
        ...(withFallback ? { fallbacks: 'default' } : {}),
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `(Where they are in setup: ${stage}.)\n\n${question}` }],
      }),
    });
  let res;
  try {
    res = await call(true);
    // The refusal fallback is a beta; if the API turns the request down, ask once more without it.
    if (retryWithoutBeta(res.status)) res = await call(false);
  } catch {
    return { status: 502, body: { error: { code: 'unreachable', message: 'The assistant could not be reached.' } } };
  }
  if (!res.ok) {
    // One line for whoever runs the site: the HTTP status and the API's error type, never the question.
    const e = (await res.json().catch(() => null))?.error;
    const type = e?.type ?? 'unknown';
    console.warn(`setup assistant: Anthropic API answered ${res.status} (${type}) ${apiDetail(e?.message)}`);
    const why = refusalReason(res.status, type, 'The assistant could not answer just now.', e?.message);
    return { status: 500, body: { error: { code: 'upstream_failed', message: why, upstream_status: res.status } } };
  }
  const msg = await res.json().catch(() => null);
  if (!msg || msg.stop_reason === 'refusal')
    return { status: 500, body: { error: { code: 'no_answer', message: 'The assistant could not answer that.' } } };
  const answer = (msg.content ?? [])
    .filter((c) => c?.type === 'text')
    .map((c) => c.text)
    .join('')
    .trim();
  if (!answer)
    return { status: 500, body: { error: { code: 'no_answer', message: 'The assistant could not answer that.' } } };
  // An answer never carries a secret back either.
  if (looksLikeSecret(answer))
    return { status: 500, body: { error: { code: 'no_answer', message: 'The assistant could not answer that.' } } };
  return { status: 200, body: { data: { answer }, as_of: new Date().toISOString(), head_seq: null, next_cursor: null } };
}
