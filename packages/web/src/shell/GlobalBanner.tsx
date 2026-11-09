import { useState } from 'react';
import { useLive } from '../api/live';
import { age, clock, useNow } from '../ui-kit/time';
import { ReleaseDialog } from './KillSwitch';
import { Link } from './router';

/** The single most serious global state, full width under the strip (handoff section 8). */
export function GlobalBanner() {
  const { connection, status: s, statusAt } = useLive();
  const now = useNow(10_000);
  const [release, setRelease] = useState(false);
  const last = statusAt ? new Date(statusAt).toISOString() : null;

  if (s?.kill_switch.state === 'stopped' && connection !== 'down') {
    const k = s.kill_switch;
    return (
      <div className="banner banner-serious" role="alert">
        <strong>Everything is stopped.</strong>
        <span>
          Stopped at {clock(k.engaged_at)}
          {k.runs_halted !== undefined
            ? `. ${k.runs_halted} run${k.runs_halted === 1 ? '' : 's'} halted`
            : ''}
          {k.keys_revoked ? ', agent keys revoked.' : '.'}
        </span>
        <span className="spacer" />
        <Link to="/runs?status=halted">What was stopped</Link>
        <button type="button" className="btn" onClick={() => setRelease(true)}>
          Release…
        </button>
        {release && <ReleaseDialog onClose={() => setRelease(false)} />}
      </div>
    );
  }
  if (s?.kill_switch.state === 'stopping' && connection !== 'down') {
    const k = s.kill_switch;
    return (
      <div className="banner banner-serious" role="status">
        <strong>Stopping…</strong>
        <span>
          {k.runs_halted ?? 0} of {k.runs_to_halt ?? '?'} runs halted. Not stopped until fwd confirms.
        </span>
      </div>
    );
  }
  if (connection === 'down') {
    return (
      <div className="banner banner-serious" role="alert">
        <strong>Can't reach fwd.</strong>
        <span>
          Showing nothing as current.{last ? ` Last update ${clock(last)}, ${age(last, now)}.` : ''} Approvals
          are disabled.
        </span>
        <span className="spacer" />
        <span>
          To stop everything from a terminal: <code>fw kill</code>
        </span>
      </div>
    );
  }
  if (s && !s.integrity.ok) {
    return (
      <div className="banner" role="alert">
        <strong>
          The event log failed its integrity check
          {s.integrity.failed_at_seq ? ` at #${s.integrity.failed_at_seq}` : ''}.
        </strong>
        <span>
          Run <code>fw audit verify</code> for details.
        </span>
      </div>
    );
  }
  if (s?.paused_by_budget || s?.breaker?.tripped) {
    return (
      <div className="banner" role="status">
        <strong>
          Paused:{' '}
          {s.breaker?.tripped ? (s.breaker.reason ?? 'budget breaker tripped') : 'daily budget reached'}.
        </strong>
        <span>New runs wait until the budget resets or the policy file changes.</span>
        <span className="spacer" />
        <Link to="/spend">Spend</Link>
      </div>
    );
  }
  return null;
}
