/**
 * Hosted mode only (VITE_FW_HOSTED=1): sign-in to the live mirror with a one-time email link,
 * through Supabase Auth's REST API. Local fwd uses pairing instead and never loads this path.
 *
 * The access token is kept in localStorage (a static site has no server session) and sent as
 * `Authorization: Bearer` to the hosted /v1. It is refreshed before it expires.
 */

const env = import.meta.env;
export const HOSTED = env.VITE_FW_HOSTED === '1';
/** What "the daemon is unreachable" means to the reader: on the mirror, no sync has arrived. */
export const UNREACHABLE = HOSTED ? 'No data from your machine yet' : "Can't reach fwd";
const URL_ = String(env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '');
const KEY = String(env.VITE_SUPABASE_ANON_KEY ?? '');
const STORE = 'fw.hosted.session';

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

async function auth(path: string, body: unknown): Promise<Response> {
  return fetch(`${URL_}/auth/v1${path}`, {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Sends the one-time sign-in link. Only the owner's email can read anything afterwards. */
export async function sendLink(email: string): Promise<void> {
  const redirect = `${location.origin}/`;
  const res = await auth(`/otp?redirect_to=${encodeURIComponent(redirect)}`, {
    email,
    // Never create accounts from this page: the auth project is shared, and only the owner may read.
    create_user: false,
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { msg?: string; error_description?: string };
    throw new Error(j.msg ?? j.error_description ?? `Sign-in link not sent (HTTP ${res.status})`);
  }
}

/**
 * The email link lands on `/#access_token=...&refresh_token=...`. Store it and clean the URL.
 * Returns an error message when the link was rejected (expired or used).
 */
export function consumeRedirect(): string | null {
  if (!HOSTED || !location.hash.includes('=')) return null;
  const h = new URLSearchParams(location.hash.slice(1));
  const clean = () => history.replaceState(null, '', location.pathname + location.search);
  if (h.get('error')) {
    clean();
    return h.get('error_description') ?? h.get('error');
  }
  const access = h.get('access_token');
  const refresh = h.get('refresh_token');
  if (!access || !refresh) return null;
  const expiresIn = Number(h.get('expires_in') ?? 3600);
  save({
    access_token: access,
    refresh_token: refresh,
    expires_at: Number(h.get('expires_at') ?? Math.floor(Date.now() / 1000) + expiresIn),
    email: emailOf(access),
  });
  clean();
  return null;
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
  if (!res.ok) {
    save(null);
    return null;
  }
  const j = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    expires_at?: number;
  };
  const next: Session = {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: j.expires_at ?? Math.floor(Date.now() / 1000) + j.expires_in,
    email: emailOf(j.access_token),
  };
  save(next);
  return next;
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

export async function signOutHosted(): Promise<void> {
  const s = memory;
  save(null);
  if (s) {
    await fetch(`${URL_}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${s.access_token}` },
    }).catch(() => undefined);
  }
}
