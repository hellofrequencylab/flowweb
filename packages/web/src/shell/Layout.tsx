import { type ReactNode, useEffect, useState } from 'react';
import { useLive } from '../api/live';
import { DawnLog } from '../dawn/DawnLog';
import { EvidencePage } from '../evidence/EvidencePage';
import { ActivationPage } from '../flows/ActivationPage';
import { HoodTabs } from '../hood';
import { LedgerPage } from '../ledger/LedgerPage';
import { RowPage } from '../ledger/RowPage';
import { ProjectsPage } from '../projects/ProjectsPage';
import { RunPage } from '../runs/RunPage';
import { RunsPage } from '../runs/RunsPage';
import { SettingsPage } from '../settings/SettingsPage';
import { SetupNudge, SetupPage } from '../setup/SetupPage';
import { SpendPage } from '../spend/SpendPage';
import { TablePage } from '../table/TablePage';
import { Footer } from './Footer';
import { GlobalBanner } from './GlobalBanner';
import { KillDialog } from './KillSwitch';
import { chord, chordPending, useKeys } from './keys';
import { BottomNav, MorePage } from './Nav';
import { usePrefs } from './prefs';
import { useRouter } from './router';
import { paramOf, routeOf } from './routes';
import { ShortcutSheet } from './ShortcutSheet';
import { StatusStrip } from './StatusStrip';

/** A page under the hood, with the tabs that move between Logs, Runs, Projects and Spend. */
function hood(page: ReactNode) {
  return (
    <>
      <HoodTabs />
      {page}
    </>
  );
}

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
      t: () => nav('/inbox'),
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
    const id = paramOf(p);
    switch (routeOf(p)) {
      case 'today':
        return (
          <>
            <SetupNudge />
            <DawnLog />
          </>
        );
      case 'setup':
        return <SetupPage />;
      case 'inbox':
        return <TablePage />;
      case 'card':
        return <TablePage cardId={id} />;
      case 'evidence':
        return <EvidencePage id={id} />;
      case 'growth':
        return <ActivationPage />;
      case 'logs':
        return hood(<LedgerPage />);
      case 'row':
        return hood(<RowPage id={id} />);
      case 'runs':
        return hood(<RunsPage />);
      case 'run':
        return hood(<RunPage id={id} />);
      case 'projects':
        return hood(<ProjectsPage />);
      case 'spend':
        return hood(<SpendPage />);
      case 'settings':
        return (
          <SettingsPage pairedAt={pairedAt} onSignedOut={onSignedOut} onOpenKill={() => setKillOpen(true)} />
        );
      case 'more':
        return <MorePage />;
      default:
        return (
          <header className="page-head">
            <h1 tabIndex={-1}>Not found</h1>
            <p className="lede">There is no page at {p}.</p>
          </header>
        );
    }
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
      <Footer />
      <BottomNav />
      {sheet && <ShortcutSheet onClose={() => setSheet(false)} />}
      {killOpen && <KillDialog onClose={() => setKillOpen(false)} />}
    </div>
  );
}
