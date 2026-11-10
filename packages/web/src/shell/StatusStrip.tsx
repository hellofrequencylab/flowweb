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
 * sit on a second line as chips.
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

  type Condition = { icon: IconName; text: string; tone?: 'warn' | 'fail' };
  const conditions: Condition[] = [];
  if (prefs.calm) conditions.push({ icon: 'paused', text: 'Calm mode' });
  if (s?.paused_by_budget) conditions.push({ icon: 'paused', text: 'Paused: budget', tone: 'warn' });
  if (s?.breaker?.tripped) conditions.push({ icon: 'warn', text: 'Breaker tripped', tone: 'warn' });
  if (s && !s.integrity.ok) conditions.push({ icon: 'fail', text: 'Integrity check failed', tone: 'fail' });

  return (
    <header className="topbar">
      <div className="topbar-row">
        <Link to="/" className="brand" aria-label="FlowWeb, Console">
          <Logo />
        </Link>
        <TopNav />
        <span className="spacer" />

        {s && s.sandbox_egress !== 'enforced' && <EgressWarning level={s.sandbox_egress} />}

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
      {conditions.length > 0 && (
        <ul className="topbar-conditions" aria-label="Standing conditions">
          {conditions.map((c) => (
            <li key={c.text} className={`chip${c.tone ? ` chip-${c.tone}` : ''}`}>
              <Icon name={c.icon} /> {c.text}
            </li>
          ))}
        </ul>
      )}
    </header>
  );
}

const EGRESS_TIP: Record<string, string> = {
  best_effort:
    'Sandbox egress: best effort. Agent runs are limited from reaching the network, but it is not guaranteed.',
  none: 'Sandbox egress: none. Agent runs on your machine are not blocked from reaching the network.',
};

/**
 * Sandbox egress that is not enforced is a standing risk, so it stays in the first
 * row of the header as an icon. The full sentence is a tooltip on hover and focus,
 * and is the accessible name, so it is never hidden from a screen reader.
 */
function EgressWarning({ level }: { level: string }) {
  const tip = EGRESS_TIP[level === 'best_effort' ? 'best_effort' : 'none'];
  return (
    <span className="tip-wrap">
      <button type="button" className="icon-btn egress-warn" aria-describedby="egress-tip">
        <Icon name="warn" size={18} />
        <span className="visually-hidden">Sandbox warning</span>
      </button>
      <span role="tooltip" id="egress-tip" className="tip">
        {tip}
      </span>
    </span>
  );
}
