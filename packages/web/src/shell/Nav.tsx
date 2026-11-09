import { useLive } from '../api/live';
import { Link, useRouter } from './router';

const ITEMS = [
  { to: '/', label: 'Dawn Log', short: 'Dawn' },
  { to: '/table', label: "Captain's Table", short: 'Table', count: true },
  { to: '/ledger', label: 'Projects and ledger', short: 'Ledger' },
  { to: '/runs', label: 'Runs' },
  { to: '/spend', label: 'Spend' },
  { to: '/settings', label: 'Settings' },
];

function active(path: string, to: string) {
  if (to === '/') return path === '/';
  if (to === '/ledger') return path.startsWith('/ledger') || path.startsWith('/projects');
  if (to === '/table') return path.startsWith('/table') || path.startsWith('/evidence');
  return path.startsWith(to);
}

function Count() {
  const { status, connection } = useLive();
  if (!status || connection === 'down' || status.cards_open === 0) return null;
  return (
    <span className="chip chip-attention">
      <span aria-hidden="true">{status.cards_open}</span>
      <span className="visually-hidden">{status.cards_open} waiting</span>
    </span>
  );
}

/** Side rail on desktop; bottom tab bar (Dawn, Table, Ledger, More) on phones. */
export function Nav() {
  const { loc } = useRouter();
  const tabs = [ITEMS[0], ITEMS[1], ITEMS[2], { to: '/more', label: 'More', short: 'More' }];
  const moreActive = ['/runs', '/spend', '/settings', '/more'].some((p) => loc.path.startsWith(p));
  return (
    <>
      <nav className="rail" aria-label="Main">
        <ul>
          {ITEMS.map((i) => (
            <li key={i.to}>
              <Link to={i.to} className="nav-link" aria-current={active(loc.path, i.to) ? 'page' : undefined}>
                {i.label}
                {i.count && <Count />}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <nav className="tabbar" aria-label="Main">
        <ul>
          {tabs.map((i) => (
            <li key={i.to}>
              <Link
                to={i.to}
                className="nav-link"
                aria-current={(i.to === '/more' ? moreActive : active(loc.path, i.to)) ? 'page' : undefined}
              >
                {i.short}
                {'count' in i && i.count && <Count />}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}

export function MorePage() {
  return (
    <>
      <h1 tabIndex={-1}>More</h1>
      <ul className="plain-list">
        {[
          { to: '/runs', label: 'Runs' },
          { to: '/spend', label: 'Spend' },
          { to: '/projects', label: 'Projects' },
          { to: '/settings', label: 'Settings and kill switch' },
        ].map((i) => (
          <li key={i.to}>
            <Link to={i.to} className="nav-link">
              {i.label}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
