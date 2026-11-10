import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, onUnauthorized } from '../api/client';
import { LiveProvider } from '../api/live';
import { HomePage } from '../home/HomePage';
import { consumeRedirect, HOSTED, signOutHosted } from '../hosted/auth';
import { Logo } from '../ui-kit/Logo';
import { Layout } from './Layout';
import { Pairing } from './Pairing';
import { PrefsProvider } from './prefs';
import { RouterProvider } from './router';

type Gate =
  | { kind: 'checking' }
  | { kind: 'unpaired'; notice?: string | null }
  | { kind: 'recovery' }
  | { kind: 'paired'; pairedAt: string }
  | { kind: 'unreachable' };

/**
 * An unpaired browser sees only the pairing screen. On the hosted mirror (VITE_FW_HOSTED=1)
 * the same gate shows the public homepage, which is also where people sign in or up.
 */
export function App() {
  // A reset link lands signed in, but must choose a new password before anything else shows.
  const [landing] = useState(() => consumeRedirect());
  const linkError = landing.error;
  const [gate, setGate] = useState<Gate>(() =>
    landing.kind === 'recovery' ? { kind: 'recovery' } : { kind: 'checking' },
  );

  const check = useCallback(() => {
    api
      .session()
      .then((s) => setGate({ kind: 'paired', pairedAt: s.paired_at }))
      .catch((e) => {
        if (HOSTED && e instanceof ApiError && e.status === 403) {
          void signOutHosted();
          setGate({ kind: 'unpaired', notice: 'That account is not the owner of this FlowWeb.' });
          return;
        }
        setGate(
          e instanceof ApiError && e.status === 401
            ? { kind: 'unpaired', notice: linkError }
            : e instanceof ApiError
              ? { kind: 'unpaired' }
              : { kind: 'unreachable' },
        );
      });
  }, [linkError]);

  useEffect(() => {
    if (landing.kind !== 'recovery') check();
    const off = onUnauthorized(() => setGate({ kind: 'unpaired' }));
    return () => {
      off();
    };
  }, [check, landing.kind]);

  return (
    <PrefsProvider>
      {gate.kind === 'checking' && (
        <p className="main">
          {HOSTED ? 'Checking your sign-in.' : 'Checking this browser is paired with fwd.'}
        </p>
      )}
      {gate.kind === 'unreachable' && <Unreachable onRetry={check} />}
      {gate.kind === 'unpaired' &&
        (HOSTED ? <HomePage notice={gate.notice} onSignedIn={check} /> : <Pairing onPaired={check} />)}
      {gate.kind === 'recovery' && <HomePage recovery onSignedIn={check} />}
      {gate.kind === 'paired' && (
        <RouterProvider>
          <LiveProvider>
            <Layout pairedAt={gate.pairedAt} onSignedOut={() => setGate({ kind: 'unpaired' })} />
          </LiveProvider>
        </RouterProvider>
      )}
    </PrefsProvider>
  );
}

function Unreachable({ onRetry }: { onRetry: () => void }) {
  if (HOSTED)
    return (
      <main className="gate stack">
        <Logo size={40} />
        <h1>Can't reach FlowWeb</h1>
        <p>The live site is not answering, so nothing here can be shown as current.</p>
        <button type="button" className="btn" onClick={onRetry}>
          Retry
        </button>
      </main>
    );
  return (
    <main className="gate stack">
      <Logo size={40} />
      <h1>Can't reach fwd</h1>
      <p>This page is served by fwd, but fwd is not answering. Nothing here can be shown as current.</p>
      <p>
        Start it from a terminal with <code>fwd</code>, then retry. To stop all agents without the app, run{' '}
        <code>fw kill</code>.
      </p>
      <button type="button" className="btn" onClick={onRetry}>
        Retry
      </button>
    </main>
  );
}
