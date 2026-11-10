// FW-C-086: which AI account each flow uses, chosen in Settings instead of by an env var at fwd start.
//
// The choice lives in $FW_HOME/flows/<key>/ai.json, beside the Owner's other per-flow files, and wins over
// the engine the flow's config.json names. Only the account is chosen here (which app, plan or API key);
// the key itself stays in the keychain and is read at run time by creds. An env var given when fwd starts
// (FW_VENDOR, FW_CLAUDE_AUTH, FW_CODEX_AUTH) still wins, as a deliberate override on this machine.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type FlowAi = { adapter: 'claude' | 'codex'; auth: 'signin' | 'api_key' };

/** The four accounts a flow can use, by the names Settings shows. */
export const AI_ACCOUNTS: Record<string, FlowAi> = {
  claude_plan: { adapter: 'claude', auth: 'signin' },
  anthropic_key: { adapter: 'claude', auth: 'api_key' },
  chatgpt_plan: { adapter: 'codex', auth: 'signin' },
  openai_key: { adapter: 'codex', auth: 'api_key' },
};

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const file = (fwHome: string, key: string) => join(fwHome, 'flows', key, 'ai.json');

export function parseFlowAi(v: unknown): FlowAi | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if ((o.adapter === 'claude' || o.adapter === 'codex') && (o.auth === 'signin' || o.auth === 'api_key'))
    return { adapter: o.adapter, auth: o.auth };
  return null;
}

/** The flow's chosen account, or null when none was chosen (the config's engine applies). */
export function readFlowAi(fwHome: string | undefined, key: string): FlowAi | null {
  if (!fwHome || !KEY_RE.test(key)) return null;
  try {
    return parseFlowAi(JSON.parse(readFileSync(file(fwHome, key), 'utf8')));
  } catch {
    return null;
  }
}

/**
 * Saves the choice. body is { account: claude_plan | anthropic_key | chatgpt_plan | openai_key }.
 * Throws Error with code INVALID for anything else. Answers whether it changed.
 */
export function writeFlowAi(
  fwHome: string,
  key: string,
  body: Record<string, unknown>,
): { changed: boolean; ai: FlowAi } {
  const account = typeof body.account === 'string' ? body.account : '';
  const ai = Object.hasOwn(AI_ACCOUNTS, account) ? AI_ACCOUNTS[account] : undefined;
  if (!ai || !KEY_RE.test(key))
    throw Object.assign(new Error(`account must be one of ${Object.keys(AI_ACCOUNTS).join(', ')}`), {
      code: 'INVALID',
    });
  const cur = readFlowAi(fwHome, key);
  if (cur && cur.adapter === ai.adapter && cur.auth === ai.auth) return { changed: false, ai };
  const dir = join(fwHome, 'flows', key);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file(fwHome, key)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ai, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file(fwHome, key));
  return { changed: true, ai };
}
