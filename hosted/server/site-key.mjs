// The site's own Anthropic key (FW_ASSISTANT_ANTHROPIC_KEY), shared by the setup assistant and the AI console.
// Reads it forgivingly (spaces and wrapping quotes from a paste are dropped), and turns an API refusal into a
// sentence that says which fix it needs. Never logs or returns the key.

/** The key from the site's env, or '' when it is not set. */
export function siteKey(env) {
  return String(env?.FW_ASSISTANT_ANTHROPIC_KEY ?? '')
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2')
    .trim();
}

/** A Claude sign-in token (from claude setup-token) is not an API key, and the API refuses it as one. */
export const isSignInToken = (key) => key.startsWith('sk-ant-oat');

export const SIGN_IN_TOKEN =
  'FW_ASSISTANT_ANTHROPIC_KEY holds a Claude sign-in token, not an API key. Make an API key at console.anthropic.com (API keys) and put that in Vercel instead.';

/** Should a refused call be asked once more without the fallback beta? */
export const retryWithoutBeta = (status) => status === 400 || status === 403;

/** The API's own error sentence, short and with anything key-shaped removed, safe for logs and the page. */
export function apiDetail(message) {
  return String(message ?? '')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[key]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

/** The person-facing reason for a refusal, by HTTP status and the API's error type. */
export function refusalReason(status, type, fallback, message = '') {
  if (status === 401 || type === 'authentication_error')
    return 'Anthropic says the site key is not valid (it may be mistyped or deleted). Make a new key at console.anthropic.com, replace FW_ASSISTANT_ANTHROPIC_KEY in Vercel (project flowweb), then redeploy.';
  if (status === 403 || type === 'permission_error')
    return "Anthropic says the site key may not do this (its workspace may not allow this model). Check the key's workspace at console.anthropic.com.";
  if (type === 'billing_error' || /credit/i.test(String(message)))
    return 'Anthropic turned the request down; the key\'s account may be out of credit. Check Plans and billing at console.anthropic.com.';
  if (status === 400 && apiDetail(message)) return `Anthropic turned the request down: ${apiDetail(message)}`;
  return fallback;
}
