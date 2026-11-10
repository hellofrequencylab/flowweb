import { type Connection, useLive } from '../api/live';
import { HOSTED } from '../hosted/auth';
import { Logo } from '../ui-kit/Logo';
import { Link } from './router';

const COLUMNS: { title: string; links: { to: string; label: string }[] }[] = [
  {
    title: 'Flows',
    links: [
      { to: '/', label: 'Your flows' },
      { to: '/inbox', label: 'Needs you' },
      { to: '/flows/neighborhood-activation', label: 'Frequency Saturation Engine' },
    ],
  },
  {
    title: 'Under the hood',
    links: [
      { to: '/ledger', label: 'Logs' },
      { to: '/runs', label: 'Runs' },
      { to: '/projects', label: 'Projects' },
      { to: '/spend', label: 'Spend' },
    ],
  },
  {
    title: 'You',
    links: [
      { to: '/settings', label: 'Settings' },
      { to: '/setup', label: 'Get started' },
    ],
  },
];

const WHERE: Record<Connection, string> = {
  live: 'connected',
  delayed: 'delayed',
  connecting: 'connecting',
  down: 'not connected',
};

/** The site footer: the mark, every page by group, and where the data comes from. */
export function Footer() {
  const { connection } = useLive();
  const source = HOSTED ? 'Mirror of your machine' : 'fwd on this machine';
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-brand">
          <Link to="/" className="brand" aria-label="FlowWeb, Today">
            <Logo size={26} />
          </Link>
          <p>Your agents find and draft. You decide, and you send.</p>
        </div>
        <nav className="site-footer-nav" aria-label="Footer">
          {COLUMNS.map((c) => (
            <div key={c.title}>
              <h2 className="overline">{c.title}</h2>
              <ul>
                {c.links.map((l) => (
                  <li key={l.to}>
                    <Link to={l.to}>{l.label}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>
      <div className="site-footer-base">
        <span className={`site-footer-source is-${connection}`}>
          <span className="flow-pulse-dot" aria-hidden="true" />
          {source}, {WHERE[connection]}
        </span>
        <span>
          Press <kbd>?</kbd> for shortcuts
        </span>
        <span>FlowWeb™ {new Date().getFullYear()}</span>
      </div>
    </footer>
  );
}
