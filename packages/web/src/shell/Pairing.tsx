import { type FormEvent, useState } from 'react';
import { ApiError, api } from '../api/client';
import { focusOnMount } from '../ui-kit/focus';
import { Logo } from '../ui-kit/Logo';

/** First visit: proves the browser belongs to the Owner. */
export function Pairing({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState('');
  const [state, setState] = useState<'idle' | 'pairing' | 'wrong' | 'unreachable'>('idle');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState('pairing');
    try {
      await api.pair(code.trim());
      onPaired();
    } catch (err) {
      setState(err instanceof ApiError ? 'wrong' : 'unreachable');
    }
  };

  return (
    <main className="gate stack">
      <Logo size={40} />
      <h1>Pair this browser</h1>
      <p>Enter the code printed in the terminal where fwd is running.</p>
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span className="field-label">Pairing code</span>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            ref={focusOnMount}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            aria-invalid={state === 'wrong'}
            aria-describedby="pair-msg"
            className="field-big mono"
          />
        </label>
        <div id="pair-msg" role="status">
          {state === 'wrong' && (
            <p className="callout callout-warn">
              That code did not match. Codes expire after 10 minutes; restart fwd for a new one.
            </p>
          )}
          {state === 'unreachable' && (
            <p className="callout callout-warn">Can't reach fwd. Check it is running, then try again.</p>
          )}
        </div>
        <button
          className="btn btn-primary btn-big"
          type="submit"
          disabled={state === 'pairing' || code.trim().length === 0}
        >
          {state === 'pairing' ? 'Pairing' : 'Pair'}
        </button>
      </form>
      <p className="muted small">
        Daemon address: <code>{location.host}</code>
      </p>
    </main>
  );
}
