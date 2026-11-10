// FW-C-085: the setup assistant's thinking, kept apart from the screen so it can be tested plainly.
//
// Three rules hold everywhere here:
//   1. A secret never enters the conversation. Anything that looks like a key or token is refused before
//      it is shown, stored or sent, and the person is told where it goes instead (their own keychain).
//   2. The guide reads real state (what the machine last reported); a click never ticks a step.
//   3. AI accounts are connected on the person's own machine. The site never holds a vendor key.

import type { MachineList, Setup } from '../api/types';

/** Shapes of keys and tokens people might paste. Better to refuse a harmless string than to keep a key. */
const SECRET_SHAPES: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/, // Anthropic API key or Claude sign-in token
  /sk-(proj|svcacct|admin)?-?[A-Za-z0-9_-]{16,}/, // OpenAI keys
  /fwr_[A-Za-z0-9_-]{8,}/, // a FlowWeb relay token
  /gh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AIza[0-9A-Za-z_-]{20,}/, // Google API keys
  /xox[abprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // a JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** A long unbroken run of letters, digits and token punctuation with both letters and digits in it. */
function hasOpaqueBlob(text: string): boolean {
  for (const word of text.split(/\s+/)) {
    if (word.length < 32 || /^https?:\/\//i.test(word)) continue;
    if (/^[A-Za-z0-9_\-+/=.]+$/.test(word) && /[0-9]/.test(word) && /[A-Za-z]/.test(word)) return true;
  }
  return false;
}

/** True when the text holds something that looks like a key, a token or a password. */
export function looksLikeSecret(text: string): boolean {
  // A Google app password is four groups of four letters and nothing else. Within a sentence such words
  // are ordinary ("much does this cost"), so only the bare shape counts.
  if (/^[a-z]{4} ?[a-z]{4} ?[a-z]{4} ?[a-z]{4}$/.test(text.trim())) return true;
  return SECRET_SHAPES.some((re) => re.test(text)) || hasOpaqueBlob(text);
}

export const SECRET_REFUSAL =
  "That looks like a key or a token, so I didn't keep it or send it anywhere. Please don't paste keys here. They go into your own computer's keychain: run the command I gave you on your machine and paste it there when it asks.";

/** The AI accounts FlowWeb can use, each connected on the person's own machine. */
export type Provider = 'claude_plan' | 'chatgpt_plan' | 'anthropic_key' | 'openai_key';

export const PROVIDERS: { id: Provider; label: string; blurb: string; command: string; test: TestKey }[] = [
  {
    id: 'claude_plan',
    label: 'Claude Pro or Max',
    blurb:
      'Uses the Claude plan you already pay for. The command opens a browser to sign in, then saves a long-lived token in your keychain. It needs the Claude Code app: npm install -g @anthropic-ai/claude-code.',
    command: 'pnpm fw accounts connect --only claude',
    test: 'claude_signin',
  },
  {
    id: 'chatgpt_plan',
    label: 'ChatGPT Plus or Pro',
    blurb:
      'Uses your ChatGPT plan through the Codex app. The command opens a browser to sign in with ChatGPT. Install Codex first if you have not: npm install -g @openai/codex.',
    command: 'pnpm fw accounts connect --only codex',
    test: 'codex_signin',
  },
  {
    id: 'anthropic_key',
    label: 'Anthropic API key',
    blurb:
      'Pay per use. Make a key at console.anthropic.com under API keys. When the command offers a plan sign-in, press Enter to skip it; then paste the key into your terminal when it asks. It goes into your keychain.',
    command: 'pnpm fw accounts connect --only claude',
    test: 'claude_api_key',
  },
  {
    id: 'openai_key',
    label: 'OpenAI API key',
    blurb:
      'Pay per use. Make a key at platform.openai.com under API keys. When the command offers a ChatGPT sign-in, you can close it; then paste the key into your terminal when it asks. It goes into your keychain.',
    command: 'pnpm fw accounts connect --only codex',
    test: 'codex_api_key',
  },
];

export type TestKey = 'claude_signin' | 'claude_api_key' | 'codex_signin' | 'codex_api_key';

/** What the guide knows, read from the machine's last report. Never from a click. */
export interface Known {
  /** A machine has pushed to this site (hosted) or fwd answers (on the Mac). */
  machine: boolean;
  /** Per AI account: true works, false failed its test, null not set up or not reported. */
  accounts: Partial<Record<TestKey, boolean | null>>;
  /** Fixes the last account test gave, per account. */
  fixes: Partial<Record<TestKey, string | null>>;
  /** Setup steps after sign-in that are not done yet, in order. */
  remaining: { id: string; title: string; fix: string | null }[];
}

export function knownFrom(setup: Setup | null, machines: MachineList | null, hosted: boolean): Known {
  const live = (machines?.machines ?? []).filter((m) => !m.revoked_at);
  const machine = hosted ? live.some((m) => m.last_seen_at) : setup?.fwd === 'up';
  const reporting = live
    .filter((m) => m.report?.account_test)
    .sort((a, b) => (b.last_seen_at ?? '').localeCompare(a.last_seen_at ?? ''))[0];
  const tests = reporting?.report?.account_test?.accounts ?? {};
  const accounts: Known['accounts'] = {};
  const fixes: Known['fixes'] = {};
  for (const k of ['claude_signin', 'claude_api_key', 'codex_signin', 'codex_api_key'] as TestKey[]) {
    const t = tests[k];
    accounts[k] = t ? (t.set_up === false ? null : t.ok) : null;
    fixes[k] = t?.fix ?? null;
  }
  // On the Mac (or when the site has the mirrored setup) the sign_ins step is the truth.
  const signIns = setup?.steps.find((s) => s.id === 'sign_ins');
  if (signIns?.done && !Object.values(accounts).some((v) => v === true)) accounts.claude_signin = true;
  const remaining = (setup?.steps ?? [])
    .filter((s) => !s.done && s.required && s.id !== 'machine' && s.id !== 'sign_ins')
    .map((s) => ({ id: s.id, title: s.title, fix: s.fix }));
  return { machine: Boolean(machine), accounts, fixes, remaining };
}

export type Stage = 'machine' | 'ai' | 'fix_ai' | 'next_steps' | 'done';

/** Where the person is: one stage, from real state. */
export function stageOf(k: Known): Stage {
  if (!k.machine) return 'machine';
  const vals = Object.values(k.accounts);
  if (vals.some((v) => v === true)) return k.remaining.length ? 'next_steps' : 'done';
  if (vals.some((v) => v === false)) return 'fix_ai';
  return 'ai';
}

/** Commands to put FlowWeb on a new machine. */
export const INSTALL_STEPS = [
  'git clone https://github.com/hellofrequencylab/flowweb.git ~/flowweb && cd ~/flowweb',
  'pnpm install',
  'pnpm fwd',
];

/** Answers that need no AI: the common setup questions, matched on plain words. */
const FAQ: { words: RegExp; answer: string }[] = [
  {
    words: /\b(safe|secure|security|store|stored|where.*(key|token)|see my key|privacy)\b/i,
    answer:
      'Your keys and sign-in tokens stay on your own computer, in its keychain. FlowWeb on your machine reads them only when it starts an AI run. This site never receives them: your machine only reports whether each account works, never the key itself.',
  },
  {
    words: /\b(cost|price|pay|cheap|expensive|money|bill|billing)\b/i,
    answer:
      'If you already pay for Claude Pro or Max, or ChatGPT Plus or Pro, use that plan: there is nothing extra to pay. An API key bills per use instead, which suits light use or a team that wants one bill.',
  },
  {
    words: /\b(which|best|recommend|should i|choose|pick|difference)\b/i,
    answer:
      'Use the plan you already have. If you have none, Claude Pro is a good start for writing outreach. You can connect more than one; FlowWeb uses the one each flow is set to.',
  },
  {
    words: /\b(windows|pc|linux|chromebook|no mac|without a mac)\b/i,
    answer:
      'FlowWeb runs on a Mac or Linux machine that stays on. On Linux, keys go in the system keyring through secret-tool, or a private file under ~/.flowweb/creds. Windows is not supported yet.',
  },
  {
    words: /\b(fail|failed|error|not work|doesn't work|broken|wrong)\b/i,
    answer:
      'Run pnpm fw accounts check on your machine. It makes one tiny real call per account and says what to fix. The result shows up here within a minute or two.',
  },
  {
    words: /\b(relay|machine|sync|mirror|connect.*(site|here))\b/i,
    answer:
      'The relay is a small program on your machine that copies what FlowWeb sees to this site every minute. Add a machine in Settings, copy the command it shows once, and run it in the FlowWeb folder while fwd is running.',
  },
  {
    words: /\b(token|setup-token|paste|two lines|wrapped)\b/i,
    answer:
      'When pnpm fw accounts connect asks for a token, paste it into your terminal, not here. It stays hidden as you paste. If the token printed over two lines, copy both lines and remove the line break before you paste.',
  },
];

export const FALLBACK_ANSWER =
  'I can help with setting up FlowWeb: putting it on your machine, connecting Claude or ChatGPT, and testing them. Try asking which AI account to use, what it costs, or where your keys are kept.';

/** A built-in answer for a setup question, or the fallback. */
export function builtInAnswer(question: string): string {
  return FAQ.find((f) => f.words.test(question))?.answer ?? FALLBACK_ANSWER;
}
