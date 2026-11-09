import { type Connection, useLive } from '../api/live';
import { Icon } from '../ui-kit/Icon';
import { age, clock, usd, useNow } from '../ui-kit/time';
import { usePrefs } from './prefs';
import { Link } from './router';

const CONN: Record<Connection, { word: string; icon: 'pass' | 'warn' | 'unknown' | 'clock' }> = {
  connecting: { word: 'Connecting', icon: 'clock' },
  live: { word: 'Live', icon: 'pass' },
  delayed: { word: 'Updates delayed', icon: 'warn' },
  down: { word: "Can't reach fwd", icon: 'unknown' },
};

/** Always visible. Every value here is either current or plainly marked otherwise. */
export function StatusStrip({ onStop }: { onStop: () => void }) {
  const { connection, status, statusAt } = useLive();
  const { prefs } = usePrefs();
  const now = useNow(10_000);
  const current = connection === 'live' || connection === 'delayed';
  const s = status;
  const kill = s?.kill_switch.state;

  return (
    <header className="strip">
      <span className="strip-brand">FlowWeb</span>
      <span
        className={`status status-${connection === 'live' ? 'ok' : connection === 'down' ? 'unknown' : 'warn'}`}
        role="status"
      >
        <Icon name={CONN[connection].icon} />
        {CONN[connection].word}
      </span>

      {s && current && s.cards_open > 0 && (
        <Link to="/table" className="chip chip-attention">
          {s.cards_open} need{s.cards_open === 1 ? 's' : ''} you
        </Link>
      )}
      {s && current && s.cards_open === 0 && <span className="muted">Nothing needs you</span>}
      {(!s || !current) && <span className="muted">Needs you: Unknown</span>}

      <span>
        Spend:{' '}
        {s?.spend_today && current ? (
          <>
            {usd(s.spend_today.usd, s.spend_today.estimated)} of {usd(s.spend_today.cap_usd)}
          </>
        ) : (
          <span className="fact-unknown">Unknown</span>
        )}
      </span>

      {prefs.calm && <span className="chip">Calm mode</span>}
      {s?.paused_by_budget && <span className="chip">Paused: budget</span>}
      {s?.breaker?.tripped && <span className="chip">Breaker tripped</span>}
      {s && s.sandbox_egress !== 'enforced' && (
        <span className="chip">
          Sandbox egress {s.sandbox_egress === 'best_effort' ? 'best effort' : 'none'}
        </span>
      )}
      {s && !s.integrity.ok && <span className="chip">Integrity check failed</span>}
      {kill === 'stopped' && <span className="chip">Stopped</span>}

      <span className="spacer" />
      <span className="asof" title={statusAt ? new Date(statusAt).toISOString() : undefined}>
        {statusAt
          ? connection === 'live'
            ? `Updated ${clock(new Date(statusAt).toISOString())}`
            : `Last update ${clock(new Date(statusAt).toISOString())}, ${age(new Date(statusAt).toISOString(), now)}`
          : 'No data yet'}
      </span>
      <button
        type="button"
        className="btn btn-stop"
        onClick={onStop}
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+Shift+."
      >
        <Icon name="stopped" /> {kill === 'stopped' ? 'Stopped' : kill === 'stopping' ? 'Stopping' : 'Stop'}
      </button>
    </header>
  );
}
