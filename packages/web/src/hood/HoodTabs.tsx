import { Link, useRouter } from '../shell/router';
import { routeOf } from '../shell/routes';

const TABS = [
  { to: '/ledger', label: 'Logs', is: ['logs', 'row'] },
  { to: '/runs', label: 'Runs', is: ['runs', 'run'] },
  { to: '/projects', label: 'Projects', is: ['projects'] },
  { to: '/spend', label: 'Spend', is: ['spend'] },
] as const;

/** Under the hood: the agent work behind the growth, as four tabs over the page they open. */
export function HoodTabs() {
  const { loc } = useRouter();
  const here = routeOf(loc.path);
  return (
    <nav className="hood-tabs" aria-label="Under the hood">
      <p className="overline hood-tabs-title">Under the hood</p>
      <ul>
        {TABS.map((t) => (
          <li key={t.to}>
            <Link
              to={t.to}
              className="nav-pill"
              aria-current={(t.is as readonly string[]).includes(here ?? '') ? 'page' : undefined}
            >
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
