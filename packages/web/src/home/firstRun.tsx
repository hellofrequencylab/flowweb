import { type FormEvent, useEffect, useRef, useState } from 'react';
import { acceptInvite, createAccount } from '../hosted/auth';
import { focusOnMount } from '../ui-kit/focus';
import { Logo } from '../ui-kit/Logo';

/**
 * What a person sees right after their first sign-in on flowweb.app (FW-C-082): name a new business, or
 * join the account an invite link pointed at. The account calls live in hosted/auth.ts.
 */

const INVITE_KEY = 'fw.invite';

/** The token in an invite link's address, /join/<token>, or null. */
export function inviteFromPath(path: string): string | null {
  const m = /^\/join\/([^/?#]+)\/?$/.exec(path);
  return m ? decodeURIComponent(m[1] as string) : null;
}

/** Keeps the invite through the sign-in, link or Google round trip, for this tab only. */
export function rememberInvite(token: string): void {
  try {
    sessionStorage.setItem(INVITE_KEY, token);
  } catch {
    /* storage blocked: the person opens the link again after signing in */
  }
}
export function pendingInvite(): string | null {
  try {
    return sessionStorage.getItem(INVITE_KEY);
  } catch {
    return null;
  }
}
export function clearInvite(): void {
  try {
    sessionStorage.removeItem(INVITE_KEY);
  } catch {
    /* nothing kept */
  }
}

const message = (err: unknown) =>
  err instanceof Error ? err.message : 'Something went wrong. Try that again.';

export function NameBusiness<T>({ onDone }: { onDone: (account: T) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean || busy) return;
    setBusy(true);
    setError(null);
    try {
      onDone((await createAccount(clean)) as T);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="gate stack">
      <Logo size={40} />
      <h1>Name your business</h1>
      <p>This is the account your flows, drafts and people live in. You can change the name later.</p>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Business name</span>
          <input
            className="home-input"
            type="text"
            name="organization"
            autoComplete="organization"
            placeholder="Sunrise Yoga"
            required
            ref={focusOnMount}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {error && (
          <p className="callout callout-fail" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary btn-big" type="submit" disabled={busy || !name.trim()}>
          {busy ? 'One moment' : 'Start my account'}
        </button>
      </form>
    </main>
  );
}

export function JoinInvite({ token, onJoined }: { token: string; onJoined: (accountId: string) => void }) {
  const [state, setState] = useState<'joining' | 'joined' | 'failed'>('joining');
  const [error, setError] = useState('');
  const asked = useRef<string | null>(null);

  useEffect(() => {
    // Once per token, even when React runs effects twice.
    if (asked.current === token) return;
    asked.current = token;
    acceptInvite(token)
      .then(({ account_id }) => {
        clearInvite();
        setState('joined');
        onJoined(account_id);
      })
      .catch((err: unknown) => {
        clearInvite();
        setError(message(err));
        setState('failed');
      });
  }, [token, onJoined]);

  return (
    <main className="gate stack">
      <Logo size={40} />
      <h1>{state === 'failed' ? 'That invite did not work' : 'Joining the team'}</h1>
      {state === 'joining' && <p role="status">Accepting your invite.</p>}
      {state === 'joined' && <p role="status">You're in. Opening FlowWeb.</p>}
      {state === 'failed' && (
        <>
          <p className="callout callout-fail" role="alert">
            {error}
          </p>
          <p>Ask whoever sent it for a fresh link, or carry on to your own account.</p>
          <button type="button" className="btn btn-primary btn-big" onClick={() => onJoined('')}>
            Go to FlowWeb
          </button>
        </>
      )}
    </main>
  );
}
