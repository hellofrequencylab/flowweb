import { type Connection, useLive } from '../api/live';
import { HOSTED } from '../hosted/auth';
import { Icon, type IconName } from '../ui-kit/Icon';
import { Logo } from '../ui-kit/Logo';
import { age, clock, usd, useNow } from '../ui-kit/time';
import { KillPill } from './KillSwitch';
import { TopNav } from './Nav';
import { usePrefs } from './prefs';
import { Link, useRouter } from './router';

const CONN: Record<Connection, { word: string; icon: IconName }> = {
  connecting: { word: 'Connecting', icon: 'clock' },
  live: { word: 'Live', icon: 'pass' },
  // The hosted mirror never has a live stream; say what it is instead of "delayed".
  delayed: { word: HOSTED ? 'Mirror of your machine' : 'Updates delayed', icon: 'delayed' },
  down: { word: HOSTED ? 'Not synced' : "Can't reach fwd", icon: 'wifi-off' },
};

/**
 * The top bar, always visible. Every value here is either current or plainly
 * marked otherwise. Standing conditions (calm mode, budget pause, sandbox)
 * sit on the same line as icons; the words are in a tooltip and the accessible name.
 */
export function StatusStrip({ onStop }: { onStop: () => void }) {
  const { connection, status, statusAt } = useLive();
  const { prefs } = usePrefs();
  const { loc } = useRouter();
  const now = useNow(10_000);
  const current = connection === 'live' || connection === 'delayed';
  const s = status;
  const last = statusAt ? new Date(statusAt).toISOString() : null;
  const asof = last
    ? connection === 'live'
      ? `Updated ${clock(last)}`
      : `Last update ${clock(last)}, ${age(last, now)}`
    : 'No data yet';

  type Condition = { icon: IconName; text: string; tip?: string; tone?: 'warn' | 'fail' };
  const conditions: Condition[] = [];
  if (prefs.calm) conditions.push({ icon: 'paused', text: 'Calm mode' });
  if (s?.paused_by_budget) conditions.push({ icon: 'paused', text: 'Paused: budget', tone: 'warn' });
  if (s?.breaker?.tripped) conditions.push({ icon: 'warn', text: 'Breaker tripped', tone: 'warn' });
  if (s?.sandbox_egress && s.sandbox_egress !== 'enforced')
    conditions.push({
      icon: 'warn',
      text: `Sandbox egress ${s.sandbox_egress === 'best_effort' ? 'best effort' : 'none'}`,
      tip:
        s.sandbox_egress === 'best_effort'
          ? 'Sandbox egress: best effort. Agent network access is limited where the machine allows it, not guaranteed.'
          : 'Sandbox egress: none. Agent runs are not stopped from reaching the network.',
      tone: 'warn',
    });
  if (s && !s.integrity.ok) conditions.push({ icon: 'fail', text: 'Integrity check failed', tone: 'fail' });

  return (
    <header className="topbar">
      <div className="topbar-row">
        <Link to="/" className="brand" aria-label="FlowWeb, Console">
          <Logo />
        </Link>
        <TopNav />
        <span className="spacer" />

        {conditions.length > 0 && (
          <ul className="topbar-conditions" aria-label="Standing conditions">
            {conditions.map((c) => (
              <li key={c.text}>
                {/* A button so keyboard users can focus it and get the same tooltip. */}
                <button
                  type="button"
                  className={`cond-icon${c.tone ? ` cond-${c.tone}` : ''}`}
                  aria-label={c.tip ?? c.text}
                  data-tip={c.tip ?? c.text}
                >
                  <Icon name={c.icon} size={18} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <span
          className={`conn conn-${connection}`}
          role="status"
          title={asof}
          aria-label={`${CONN[connection].word}. ${asof}`}
        >
          <Icon name={CONN[connection].icon} />
          <span className="hide-narrow">{CONN[connection].word}</span>
        </span>

        {s && current && s.cards_open > 0 && (
          <Link to="/table" className="needs-pill">
            {s.cards_open} need{s.cards_open === 1 ? 's' : ''} you
          </Link>
        )}
        {(!s || !current) && <span className="topbar-meta hide-tablet">Needs you: Unknown</span>}

        <span className="topbar-meta hide-tablet">
          {s?.spend_today && current ? (
            <>
              <strong>{usd(s.spend_today.usd, s.spend_today.estimated)}</strong> of{' '}
              {usd(s.spend_today.cap_usd)} today
            </>
          ) : (
            <>
              Spend: <span className="fact-unknown">Unknown</span>
            </>
          )}
        </span>

        <Link
          to="/settings"
          className="icon-btn topbar-settings"
          aria-label="Settings"
          aria-current={loc.path.startsWith('/settings') ? 'page' : undefined}
        >
          <Icon name="settings" size={18} />
        </Link>
        <KillPill onOpen={onStop} />
      </div>
    </header>
  );
}
