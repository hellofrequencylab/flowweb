import { type FormEvent, useState } from 'react';
import { focusOnMount } from '../ui-kit/focus';
import { Logo } from '../ui-kit/Logo';
import { sendLink } from './auth';

/** Hosted mode's first screen, in place of pairing. */
export function SignIn({ notice }: { notice?: string | null }) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const [message, setMessage] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState('sending');
    try {
      await sendLink(email.trim());
      setState('sent');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
      setState('failed');
    }
  };

  return (
    <main className="gate stack">
      <Logo size={40} />
      <h1>Sign in to FlowWeb</h1>
      <p>
        We'll email you a one-time link. Only the owner of this FlowWeb can see anything after signing in.
      </p>
      {notice && <p className="callout callout-warn">{notice}</p>}
      {state === 'sent' ? (
        <p className="callout" role="status">
          Check your email for the sign-in link. It works once and expires after an hour.
        </p>
      ) : (
        <form onSubmit={submit} className="stack">
          <label className="field">
            <span className="field-label">Email</span>
            <input
              type="email"
              autoComplete="email"
              required
              ref={focusOnMount}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-describedby="signin-msg"
              className="field-big"
            />
          </label>
          <div id="signin-msg" role="status">
            {state === 'failed' && <p className="callout callout-warn">{message}</p>}
          </div>
          <button
            className="btn btn-primary btn-big"
            type="submit"
            disabled={state === 'sending' || email.trim().length === 0}
          >
            {state === 'sending' ? 'Sending' : 'Email me a link'}
          </button>
        </form>
      )}
      <p className="muted small">
        This is the live mirror of FlowWeb on your machine. Approvals and the kill switch stay in FlowWeb
        there.
      </p>
    </main>
  );
}
