import { type ReactNode, useEffect, useState } from 'react';
import { useLive } from '../api/live';
import { DawnLog } from '../dawn/DawnLog';
import { EvidencePage } from '../evidence/EvidencePage';
import { ActivationPage } from '../flows/ActivationPage';
import { LedgerPage } from '../ledger/LedgerPage';
import { RowPage } from '../ledger/RowPage';
import { ProjectsPage } from '../projects/ProjectsPage';
import { RunPage } from '../runs/RunPage';
import { RunsPage } from '../runs/RunsPage';
import { SettingsPage } from '../settings/SettingsPage';
import { SetupNudge, SetupPage } from '../setup/SetupPage';
import { SpendPage } from '../spend/SpendPage';
import { TablePage } from '../table/TablePage';
import { GlobalBanner } from './GlobalBanner';
import { KillDialog } from './KillSwitch';
import { chord, chordPending, useKeys } from './keys';
import { BottomNav, MorePage } from './Nav';
import { usePrefs } from './prefs';
import { match, useRouter } from './router';
import { ShortcutSheet } from './ShortcutSheet';
import { StatusStrip } from './StatusStrip';

export function Layout({ pairedAt, onSignedOut }: { pairedAt: string; onSignedOut: () => void }) {
  const { loc, go } = useRouter();
  const { prefs, set } = usePrefs();
  const { status } = useLive();
  const [sheet, setSheet] = useState(false);
  const [killOpen, setKillOpen] = useState(false);

  // Title tells the Owner when something needs them, without nagging.
  useEffect(() => {
    const n = status?.cards_open ?? 0;
    document.title = n > 0 ? `(${n}) FlowWeb` : 'FlowWeb';
  }, [status?.cards_open]);

  const nav = (to: string) => {
    if (!chordPending()) return;
    // Reset after other key handlers have seen this key press, so screen keys yield to it.
    setTimeout(() => (chord.gAt = 0));
    go(to);
  };

  useKeys(
    {
      '?': () => setSheet(true),
      m: () => set({ calm: !prefs.calm }),
      'mod+shift+.': () => setKillOpen(true),
      g: () => {
        chord.gAt = Date.now();
      },
      h: () => nav('/'),
      t: () => nav('/table'),
      l: () => nav('/ledger'),
      r: () => nav('/runs'),
      s: () => nav('/spend'),
    },
    prefs.shortcuts,
  );
  // Ctrl/Cmd+Shift+. works even with single-key shortcuts off.
  useKeys({ 'mod+shift+.': () => setKillOpen(true) }, !prefs.shortcuts);

  const page = pageFor(loc.path);

  function pageFor(p: string): ReactNode {
    if (p === '/')
      return (
        <>
          <SetupNudge />
          <DawnLog />
        </>
      );
    if (p === '/setup') return <SetupPage />;
    if (p === '/table') return <TablePage />;
    const card = match('/table/:card', p);
    if (card) return <TablePage cardId={card.card} />;
    const evidence = match('/evidence/:id', p);
    if (evidence) return <EvidencePage id={evidence.id} />;
    if (p === '/projects') return <ProjectsPage />;
    if (p === '/ledger') return <LedgerPage />;
    const row = match('/ledger/:id', p);
    if (row) return <RowPage id={row.id} />;
    if (p === '/runs') return <RunsPage />;
    const run = match('/runs/:id', p);
    if (run) return <RunPage id={run.id} />;
    if (p === '/spend') return <SpendPage />;
    if (p === '/flows') return <ActivationPage />;
    if (p === '/settings')
      return (
        <SettingsPage pairedAt={pairedAt} onSignedOut={onSignedOut} onOpenKill={() => setKillOpen(true)} />
      );
    if (p === '/more') return <MorePage />;
    return (
      <header className="page-head">
        <h1 tabIndex={-1}>Not found</h1>
        <p className="lede">There is no page at {p}.</p>
      </header>
    );
  }

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <StatusStrip onStop={() => setKillOpen(true)} />
      <div className="banner-area">
        <GlobalBanner />
      </div>
      <main id="main" className="main">
        {page}
      </main>
      <BottomNav />
      {sheet && <ShortcutSheet onClose={() => setSheet(false)} />}
      {killOpen && <KillDialog onClose={() => setKillOpen(false)} />}
    </div>
  );
}
