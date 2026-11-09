import { type FormEvent, useState } from 'react';
import { focusOnMount } from '../ui-kit/focus';
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
    <main
      className="main stack"
      style={{ maxWidth: '28rem', margin: '0 auto', paddingTop: 'var(--fw-space-6)' }}
    >
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
          <label className="stack" style={{ display: 'block' }}>
            <span>Email</span>
            <br />
            <input
              type="email"
              autoComplete="email"
              required
              ref={focusOnMount}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-describedby="signin-msg"
              style={{ width: '100%', fontSize: 'var(--fw-text-lg)' }}
            />
          </label>
          <div id="signin-msg" role="status">
            {state === 'failed' && <p className="callout callout-warn">{message}</p>}
          </div>
          <button
            className="btn btn-primary"
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
