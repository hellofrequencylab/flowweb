import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, onUnauthorized } from '../api/client';
import { LiveProvider } from '../api/live';
import { consumeRedirect, HOSTED, signOutHosted } from '../hosted/auth';
import { SignIn } from '../hosted/SignIn';
import { Layout } from './Layout';
import { Pairing } from './Pairing';
import { PrefsProvider } from './prefs';
import { RouterProvider } from './router';

type Gate =
  | { kind: 'checking' }
  | { kind: 'unpaired'; notice?: string | null }
  | { kind: 'paired'; pairedAt: string }
  | { kind: 'unreachable' };

/**
 * An unpaired browser sees only the pairing screen. On the hosted mirror (VITE_FW_HOSTED=1)
 * the same gate shows email sign-in instead.
 */
export function App() {
  const [gate, setGate] = useState<Gate>({ kind: 'checking' });
  const [linkError] = useState(() => consumeRedirect());

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
    check();
    const off = onUnauthorized(() => setGate({ kind: 'unpaired' }));
    return () => {
      off();
    };
  }, [check]);

  return (
    <PrefsProvider>
      {gate.kind === 'checking' && (
        <p className="main">
          {HOSTED ? 'Checking your sign-in.' : 'Checking this browser is paired with fwd.'}
        </p>
      )}
      {gate.kind === 'unreachable' && <Unreachable onRetry={check} />}
      {gate.kind === 'unpaired' && (HOSTED ? <SignIn notice={gate.notice} /> : <Pairing onPaired={check} />)}
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
      <main className="main stack" style={{ maxWidth: '36rem', margin: '0 auto' }}>
        <h1>Can't reach FlowWeb</h1>
        <p>The live site is not answering, so nothing here can be shown as current.</p>
        <button type="button" className="btn" onClick={onRetry}>
          Retry
        </button>
      </main>
    );
  return (
    <main className="main stack" style={{ maxWidth: '36rem', margin: '0 auto' }}>
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
