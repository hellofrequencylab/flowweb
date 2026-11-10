/**
 * Hosted mode only (VITE_FW_HOSTED=1): logins for flowweb.app through Supabase Auth's REST API.
 * Local fwd uses pairing instead and never loads this path.
 *
 * Ways in: email and password, a one-time email link, or Google (when VITE_FW_AUTH_GOOGLE is on),
 * plus a password reset. The access token is kept in localStorage (a static site has no server
 * session) and sent as `Authorization: Bearer` to the hosted /v1. It is refreshed before it expires.
 *
 * Every message a person sees comes from SAY below, never from Supabase's text or from a link's
 * error_description, so a crafted link cannot put someone else's words on our page.
 */
const env = import.meta.env;
export const HOSTED = env.VITE_FW_HOSTED === '1';
/** What "the daemon is unreachable" means to the reader: on the mirror, no sync has arrived. */
export const UNREACHABLE = HOSTED ? 'No data from your machine yet' : "Can't reach fwd";
const URL_ = String(env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '');
const KEY = String(env.VITE_SUPABASE_ANON_KEY ?? '');
const STORE = 'fw.hosted.session';

/** Which ways in the sign-in screens should offer. Google needs its provider set up first. */
export const authMethods = {
  password: true,
  link: true,
  google: ['1', 'true', 'on'].includes(String(env.VITE_FW_AUTH_GOOGLE ?? '').toLowerCase()),
} as const;

const SAY = {
  credentials: 'That email and password do not match. Check them, or sign in with an email link instead.',
  confirm: 'Confirm your email first: open the link we sent you, then sign in.',
  taken: 'That email already has a login. Sign in instead, or reset your password.',
  weak: 'Choose a longer password: at least 8 characters.',
  email: 'That does not look like an email address.',
  slow: 'Too many tries in a row. Wait a minute, then try again.',
  expired: 'That link has expired or was already used. Ask for a new one.',
  cancelled: 'Google sign-in was cancelled. Try again, or use your email.',
  signedOut: 'Sign in first.',
  failed: 'Something went wrong on our side. Try again in a moment.',
} as const;

interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch seconds
  email: string | null;
}

function load(): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Session | null;
    return s?.access_token ? s : null;
  } catch {
    return null;
  }
}
function save(s: Session | null) {
  try {
    if (s) localStorage.setItem(STORE, JSON.stringify(s));
    else localStorage.removeItem(STORE);
  } catch {
    /* storage blocked: the session lasts for this page only */
  }
  memory = s;
}
let memory: Session | null = HOSTED ? load() : null;

const home = () => `${location.origin}/`;

async function auth(path: string, body: unknown, init: { method?: string; token?: string } = {}) {
  return fetch(`${URL_}/auth/v1${path}`, {
    method: init.method ?? 'POST',
    headers: {
      apikey: KEY,
      'Content-Type': 'application/json',
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** Supabase's error, mapped to one of our sentences. Its own text is never shown. */
async function failure(res: Response): Promise<Error> {
  const j = (await res.json().catch(() => ({}))) as { error_code?: string; code?: string | number };
  const code = String(j.error_code ?? j.code ?? '');
  if (res.status === 429 || /rate_limit/.test(code)) return new Error(SAY.slow);
  if (code === 'invalid_credentials' || code === 'invalid_grant') return new Error(SAY.credentials);
  if (code === 'email_not_confirmed') return new Error(SAY.confirm);
  if (code === 'user_already_exists' || code === 'email_exists') return new Error(SAY.taken);
  if (code === 'weak_password') return new Error(SAY.weak);
  if (code === 'validation_failed' || code === 'email_address_invalid') return new Error(SAY.email);
  if (code === 'otp_expired' || code === 'flow_state_expired') return new Error(SAY.expired);
  return new Error(SAY.failed);
}

interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
}

function keep(j: TokenAnswer): boolean {
  if (!j.access_token || !j.refresh_token) return false;
  save({
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: j.expires_at ?? Math.floor(Date.now() / 1000) + (j.expires_in ?? 3600),
    email: emailOf(j.access_token),
  });
  return true;
}

/** Signs in with email and password and keeps the session. */
export async function signInWithPassword(email: string, password: string): Promise<void> {
  const res = await auth('/token?grant_type=password', { email: email.trim(), password });
  if (!res.ok) throw await failure(res);
  if (!keep((await res.json()) as TokenAnswer)) throw new Error(SAY.failed);
}

/** Makes a new login. needsConfirm is true when the email must be confirmed before signing in. */
export async function signUp(email: string, password: string): Promise<{ needsConfirm: boolean }> {
  const res = await auth(`/signup?redirect_to=${encodeURIComponent(home())}`, {
    email: email.trim(),
    password,
  });
  if (!res.ok) throw await failure(res);
  return { needsConfirm: !keep((await res.json()) as TokenAnswer) };
}

/** Sends a one-time sign-in link. It makes the login if the email is new. */
export async function sendLink(email: string): Promise<void> {
  const res = await auth(`/otp?redirect_to=${encodeURIComponent(home())}`, {
    email: email.trim(),
    create_user: true,
  });
  if (!res.ok) throw await failure(res);
}

/** Where "Continue with Google" goes. Google sends the person back to this site's front page. */
export function googleUrl(): string {
  return `${URL_}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(home())}`;
}

export function signInWithGoogle(): void {
  location.assign(googleUrl());
}

/** Emails a link that lands as a 'recovery' redirect, where the screens ask for a new password. */
export async function sendPasswordReset(email: string): Promise<void> {
  const res = await auth(`/recover?redirect_to=${encodeURIComponent(home())}`, { email: email.trim() });
  if (!res.ok) throw await failure(res);
}

/** Sets a new password for the signed-in person (after a reset link, or from Settings). */
export async function setPassword(password: string): Promise<void> {
  const token = await accessToken();
  if (!token) throw new Error(SAY.signedOut);
  const res = await auth('/user', { password }, { method: 'PUT', token });
  if (!res.ok) throw await failure(res);
}

const LINK_ERRORS: Record<string, string> = {
  otp_expired: SAY.expired,
  flow_state_expired: SAY.expired,
  access_denied: SAY.cancelled,
};

/**
 * Every emailed link and Google land on `/#access_token=...` (or `/#error=...`). Keeps the session,
 * cleans the URL, and says what landed: a password reset ('recovery'), any other sign-in, or nothing.
 */
export function consumeRedirect(): { kind: 'signin' | 'recovery' | null; error: string | null } {
  const none = { kind: null, error: null } as const;
  if (!HOSTED || !location.hash.includes('=')) return none;
  const h = new URLSearchParams(location.hash.slice(1));
  const clean = () => history.replaceState(null, '', location.pathname + location.search);
  if (h.get('error') || h.get('error_code')) {
    const code = h.get('error_code') ?? h.get('error') ?? '';
    clean();
    return { kind: null, error: LINK_ERRORS[code] ?? (/expired/.test(code) ? SAY.expired : SAY.failed) };
  }
  const access = h.get('access_token');
  const refresh = h.get('refresh_token');
  if (!access || !refresh) return none;
  keep({
    access_token: access,
    refresh_token: refresh,
    expires_in: Number(h.get('expires_in') ?? 3600),
    ...(h.get('expires_at') ? { expires_at: Number(h.get('expires_at')) } : {}),
  });
  clean();
  return { kind: h.get('type') === 'recovery' ? 'recovery' : 'signin', error: null };
}

function emailOf(jwt: string): string | null {
  try {
    const p = JSON.parse(atob(jwt.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as {
      email?: string;
    };
    return p.email ?? null;
  } catch {
    return null;
  }
}

let refreshing: Promise<Session | null> | null = null;
async function refresh(s: Session): Promise<Session | null> {
  const res = await auth('/token?grant_type=refresh_token', { refresh_token: s.refresh_token });
  if (!res.ok || !keep((await res.json()) as TokenAnswer)) {
    save(null);
    return null;
  }
  return memory;
}

/** A valid access token, refreshed when it has under a minute left; null when signed out. */
export async function accessToken(): Promise<string | null> {
  const s = memory;
  if (!s) return null;
  if (s.expires_at - 60 > Date.now() / 1000) return s.access_token;
  refreshing ??= refresh(s).finally(() => {
    refreshing = null;
  });
  return (await refreshing)?.access_token ?? null;
}

export function signedInEmail(): string | null {
  return memory?.email ?? null;
}

/** Forgets the session here and ends it at Supabase. */
export async function signOut(): Promise<void> {
  const s = memory;
  save(null);
  if (s) {
    await fetch(`${URL_}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${s.access_token}` },
    }).catch(() => undefined);
  }
}
/** The older name; the shell still calls it. */
export const signOutHosted = signOut;

// The hosted /v1 account calls (row FW-C-083 serves them).

export interface AccountSummary {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'helper' | 'viewer';
  flows: string[] | null;
}

async function v1<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await accessToken();
  if (!token) throw new Error(SAY.signedOut);
  const res = await fetch(`/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const j = (await res.json().catch(() => ({}))) as { data?: T; error?: { message?: string } };
  if (!res.ok) throw new Error(res.status === 401 ? SAY.signedOut : (j.error?.message ?? SAY.failed));
  return j.data as T;
}

/** The businesses this login belongs to, with its role in each. A new login has none. */
export const listAccounts = () => v1<AccountSummary[]>('GET', '/accounts');
/** Makes a business with this login as its owner. */
export const createAccount = (name: string) =>
  v1<{ id: string; name: string }>('POST', '/accounts', { name });
/** Joins the business (or flow) an invite link names. */
export const acceptInvite = (token: string) =>
  v1<{ account_id: string }>('POST', `/invites/${encodeURIComponent(token)}/accept`);
