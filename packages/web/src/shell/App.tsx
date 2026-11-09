import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, onUnauthorized } from '../api/client';
import { LiveProvider } from '../api/live';
import { Layout } from './Layout';
import { Pairing } from './Pairing';
import { PrefsProvider } from './prefs';
import { RouterProvider } from './router';

type Gate =
  | { kind: 'checking' }
  | { kind: 'unpaired' }
  | { kind: 'paired'; pairedAt: string }
  | { kind: 'unreachable' };

/** An unpaired browser sees only the pairing screen. */
export function App() {
  const [gate, setGate] = useState<Gate>({ kind: 'checking' });

  const check = useCallback(() => {
    api
      .session()
      .then((s) => setGate({ kind: 'paired', pairedAt: s.paired_at }))
      .catch((e) =>
        setGate(
          e instanceof ApiError && e.status === 401
            ? { kind: 'unpaired' }
            : e instanceof ApiError
              ? { kind: 'unpaired' }
              : { kind: 'unreachable' },
        ),
      );
  }, []);

  useEffect(() => {
    check();
    const off = onUnauthorized(() => setGate({ kind: 'unpaired' }));
    return () => {
      off();
    };
  }, [check]);

  return (
    <PrefsProvider>
      {gate.kind === 'checking' && <p className="main">Checking this browser is paired with fwd.</p>}
      {gate.kind === 'unreachable' && <Unreachable onRetry={check} />}
      {gate.kind === 'unpaired' && <Pairing onPaired={check} />}
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
