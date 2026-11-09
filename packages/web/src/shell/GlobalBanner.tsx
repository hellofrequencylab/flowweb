import { type ReactNode, useState } from 'react';
import { useLive } from '../api/live';
import { HOSTED, UNREACHABLE } from '../hosted/auth';
import { Icon, type IconName } from '../ui-kit/Icon';
import { age, clock, useNow } from '../ui-kit/time';
import { ReleaseDialog } from './KillSwitch';
import { Link } from './router';

function Banner({
  tone,
  icon,
  role,
  title,
  body,
  actions,
}: {
  tone: 'stop' | 'down' | 'fail' | 'caution';
  icon: IconName;
  role: 'alert' | 'status';
  title: ReactNode;
  body?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={`banner banner-${tone}`} role={role}>
      <div className="banner-main">
        <Icon name={icon} size={20} />
        <div className="banner-text">
          <strong className="banner-title">{title}</strong>
          {body && <span className="banner-body">{body}</span>}
        </div>
      </div>
      {actions && <div className="banner-actions">{actions}</div>}
    </div>
  );
}

/** The single most serious global state, full width under the top bar (handoff section 8). */
export function GlobalBanner() {
  const { connection, status: s, statusAt } = useLive();
  const now = useNow(10_000);
  const [release, setRelease] = useState(false);
  const last = statusAt ? new Date(statusAt).toISOString() : null;

  if (s?.kill_switch.state === 'stopped' && connection !== 'down') {
    const k = s.kill_switch;
    return (
      <Banner
        tone="stop"
        icon="stopped"
        role="alert"
        title="Everything is stopped."
        body={
          <>
            Stopped at {clock(k.engaged_at)}
            {k.runs_halted !== undefined
              ? `. ${k.runs_halted} run${k.runs_halted === 1 ? '' : 's'} halted`
              : ''}
            {k.keys_revoked ? ', agent keys revoked.' : '.'}
          </>
        }
        actions={
          <>
            <Link to="/runs?status=halted" className="btn btn-quiet">
              What was stopped
            </Link>
            <button type="button" className="btn" onClick={() => setRelease(true)}>
              <Icon name="retry" /> Release…
            </button>
            {release && <ReleaseDialog onClose={() => setRelease(false)} />}
          </>
        }
      />
    );
  }
  if (s?.kill_switch.state === 'stopping' && connection !== 'down') {
    const k = s.kill_switch;
    return (
      <Banner
        tone="stop"
        icon="stopped"
        role="status"
        title="Stopping…"
        body={`${k.runs_halted ?? 0} of ${k.runs_to_halt ?? '?'} runs halted. Not stopped until fwd confirms.`}
      />
    );
  }
  if (connection === 'down') {
    return (
      <Banner
        tone="down"
        icon="wifi-off"
        role="alert"
        title={`${UNREACHABLE}.`}
        body={
          <>
            Showing nothing as current.{last ? ` Last update ${clock(last)}, ${age(last, now)}.` : ''}{' '}
            Approvals are disabled.{' '}
            {HOSTED ? (
              <>Start FlowWeb and the relay on your machine (Settings, Machines).</>
            ) : (
              <>
                To stop everything from a terminal: <code>fw kill</code>
              </>
            )}
          </>
        }
      />
    );
  }
  if (s && !s.integrity.ok) {
    return (
      <Banner
        tone="fail"
        icon="shield-x"
        role="alert"
        title={`The event log failed its integrity check${s.integrity.failed_at_seq ? ` at #${s.integrity.failed_at_seq}` : ''}.`}
        body={
          <>
            Run <code>fw audit verify</code> for details.
          </>
        }
      />
    );
  }
  if (s?.paused_by_budget || s?.breaker?.tripped) {
    return (
      <Banner
        tone="caution"
        icon="paused"
        role="status"
        title={`Paused: ${s.breaker?.tripped ? (s.breaker.reason ?? 'budget breaker tripped') : 'daily budget reached'}.`}
        body="New runs wait until the budget resets or the policy file changes."
        actions={
          <Link to="/spend" className="btn btn-quiet">
            <Icon name="spend" /> Spend
          </Link>
        }
      />
    );
  }
  return null;
}
