import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, onUnauthorized } from '../api/client';
import { LiveProvider } from '../api/live';
import { Console } from '../console/Console';
import {
  clearInvite,
  inviteFromPath,
  JoinInvite,
  NameBusiness,
  pendingInvite,
  rememberInvite,
} from '../home/firstRun';
import { HomePage } from '../home/HomePage';
import { accessToken, chooseAccount, consumeRedirect, HOSTED, listAccounts } from '../hosted/auth';
import { LegalPage, legalRouteOf } from '../legal/Legal';
import { Logo } from '../ui-kit/Logo';
import { Layout } from './Layout';
import { Pairing } from './Pairing';
import { PrefsProvider } from './prefs';
import { RouterProvider } from './router';

type Gate =
  | { kind: 'checking' }
  | { kind: 'unpaired'; notice?: string | null }
  | { kind: 'recovery' }
  | { kind: 'join'; token: string }
  | { kind: 'name' }
  | { kind: 'paired'; pairedAt: string }
  | { kind: 'unreachable' };

/**
 * An unpaired browser sees only the pairing screen. On the hosted mirror (VITE_FW_HOSTED=1)
 * the same gate shows the public homepage, which is also where people sign in or up.
 */
export function App() {
  // Terms and Privacy open for anyone, signed in or not (FW-C-090).
  const legal = legalRouteOf(location.pathname);
  if (legal) return <LegalPage page={legal} />;
  return <Gated />;
}

function Gated() {
  // A reset link lands signed in, but must choose a new password before anything else shows.
  const [landing] = useState(() => {
    // An invite link, /join/<token>, is kept through sign-in and the address goes back to the homepage.
    const invite = HOSTED ? inviteFromPath(location.pathname) : null;
    if (invite) {
      rememberInvite(invite);
      history.replaceState(null, '', '/');
    }
    return consumeRedirect();
  });
  const linkError = landing.error;
  const [gate, setGate] = useState<Gate>(() =>
    landing.kind === 'recovery' ? { kind: 'recovery' } : { kind: 'checking' },
  );

  const session = useCallback(() => {
    api
      .session()
      .then((s) => setGate({ kind: 'paired', pairedAt: s.paired_at }))
      .catch((e) => {
        // On the site a 403 means "not a member of the business you picked"; there is no owner-only gate now.
        if (HOSTED && e instanceof ApiError && e.status === 403) {
          setGate({
            kind: 'unpaired',
            notice: 'You are not part of that business. Ask its owner for an invite.',
          });
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

  /** Signed in on the site: join a pending invite first, then name a business if there is none yet. */
  const check = useCallback(async () => {
    if (HOSTED && (await accessToken())) {
      const invite = pendingInvite();
      if (invite) return setGate({ kind: 'join', token: invite });
      const accounts = await listAccounts().catch(() => null);
      if (accounts && accounts.length === 0) return setGate({ kind: 'name' });
    }
    session();
  }, [session]);
  const joined = useCallback(
    (accountId: string) => {
      clearInvite();
      // FW-C-088: the business just joined is the one the site shows.
      if (accountId) chooseAccount(accountId);
      void check();
    },
    [check],
  );

  useEffect(() => {
    if (landing.kind !== 'recovery') void check();
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
      {gate.kind === 'unreachable' && <Unreachable onRetry={() => void check()} />}
      {gate.kind === 'unpaired' &&
        (HOSTED ? (
          <HomePage notice={gate.notice} invite={pendingInvite() !== null} onSignedIn={() => void check()} />
        ) : (
          <Pairing onPaired={() => void check()} />
        ))}
      {gate.kind === 'recovery' && <HomePage recovery onSignedIn={() => void check()} />}
      {gate.kind === 'join' && <JoinInvite token={gate.token} onJoined={joined} />}
      {gate.kind === 'name' && (
        <NameBusiness<{ id: string }>
          onDone={(account) => {
            chooseAccount(account.id);
            session();
          }}
        />
      )}
      {gate.kind === 'paired' && (
        <RouterProvider>
          <LiveProvider>
            <Layout pairedAt={gate.pairedAt} onSignedOut={() => setGate({ kind: 'unpaired' })} />
            {/* FW-C-092: the AI console, bottom right on every page. */}
            <Console />
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
