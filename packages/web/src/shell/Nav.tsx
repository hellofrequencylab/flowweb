import { useLive } from '../api/live';
import { Icon, type IconName } from '../ui-kit/Icon';
import { Link, useRouter } from './router';

const ITEMS: { to: string; label: string; short: string; icon: IconName; count?: boolean }[] = [
  { to: '/', label: 'Dawn Log', short: 'Dawn', icon: 'dawn' },
  { to: '/table', label: "Captain's Table", short: 'Table', icon: 'table', count: true },
  { to: '/ledger', label: 'Projects and ledger', short: 'Ledger', icon: 'ledger' },
  { to: '/runs', label: 'Runs', short: 'Runs', icon: 'runs' },
  { to: '/spend', label: 'Spend', short: 'Spend', icon: 'spend' },
];

function active(path: string, to: string) {
  if (to === '/') return path === '/';
  if (to === '/ledger') return path.startsWith('/ledger') || path.startsWith('/projects');
  if (to === '/table') return path.startsWith('/table') || path.startsWith('/evidence');
  return path.startsWith(to);
}

/** Saffron count of cards waiting on the Owner. Hidden when it is not current. */
function Count() {
  const { status, connection } = useLive();
  if (!status || connection === 'down' || status.cards_open === 0) return null;
  return (
    <span className="count">
      <span aria-hidden="true">{status.cards_open}</span>
      <span className="visually-hidden">, {status.cards_open} waiting</span>
    </span>
  );
}

/** Nav pills in the top bar (desktop and tablet). */
export function TopNav() {
  const { loc } = useRouter();
  return (
    <nav className="topnav" aria-label="Main">
      <ul>
        {ITEMS.map((i) => (
          <li key={i.to}>
            <Link to={i.to} className="nav-pill" aria-current={active(loc.path, i.to) ? 'page' : undefined}>
              <Icon name={i.icon} size={16} />
              <span className="nav-full">{i.label}</span>
              <span className="nav-short">{i.short}</span>
              {i.count && <Count />}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Bottom tab bar on phones: Dawn, Table, Ledger, More. */
export function BottomNav() {
  const { loc } = useRouter();
  const tabs = [...ITEMS.slice(0, 3), { to: '/more', label: 'More', short: 'More', icon: 'more' as const }];
  const moreActive = ['/runs', '/spend', '/settings', '/more'].some((p) => loc.path.startsWith(p));
  return (
    <nav className="bottomnav" aria-label="Main">
      <ul>
        {tabs.map((i) => (
          <li key={i.to} style={{ display: 'contents' }}>
            <Link
              to={i.to}
              className="tab"
              aria-current={(i.to === '/more' ? moreActive : active(loc.path, i.to)) ? 'page' : undefined}
            >
              <span className="tab-icon">
                <Icon name={i.icon} size={20} />
                {'count' in i && i.count && <Count />}
              </span>
              {i.short}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function MorePage() {
  const items: { to: string; label: string; desc: string; icon: IconName }[] = [
    { to: '/runs', label: 'Runs', desc: 'Every run, live and finished', icon: 'runs' },
    { to: '/spend', label: 'Spend', desc: 'Today against the cap, and the last seven days', icon: 'spend' },
    { to: '/projects', label: 'Projects', desc: 'Repositories FlowWeb works in', icon: 'ledger' },
    {
      to: '/settings',
      label: 'Settings and kill switch',
      desc: 'Preferences, pairing, stop',
      icon: 'settings',
    },
  ];
  return (
    <>
      <header className="page-head">
        <h1 tabIndex={-1}>More</h1>
      </header>
      <ul className="link-list">
        {items.map((i) => (
          <li key={i.to}>
            <Link to={i.to} className="link-card">
              <span className="icon-tile">
                <Icon name={i.icon} size={18} />
              </span>
              <span className="link-card-text">
                <strong>{i.label}</strong>
                <span>{i.desc}</span>
              </span>
              <Icon name="chevron-right" size={16} />
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
