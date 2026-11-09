import { useEffect, useState } from 'react';
import { useStill } from '../shell/prefs';
import { Link } from '../shell/router';
import { Icon } from '../ui-kit/Icon';
import { clock } from '../ui-kit/time';

/**
 * The only two reward moments (handoff section 9). Both fire from facts fwd
 * confirmed, both say why, both link to the evidence, neither blocks anything.
 * Calm mode: a static tick and one caption. No sound, no confetti, no streaks.
 */

export function TableCleared({
  count,
  minutes,
  checkedAt,
}: {
  count: number;
  minutes: number;
  checkedAt: string;
}) {
  const still = useStill();
  return (
    <div className="reward" role="status">
      <span className={still ? '' : 'reward-mark'} style={{ color: 'var(--fw-ok)' }}>
        <Icon name="pass" size={24} />
      </span>
      <div>
        <p style={{ margin: 0 }}>
          <strong>Table cleared.</strong>{' '}
          {still
            ? ''
            : `Cleared ${count} decision${count === 1 ? '' : 's'} in ${minutes} minute${minutes === 1 ? '' : 's'}.`}
        </p>
        <p className="small muted" style={{ margin: 0 }}>
          Why: fwd reports zero open cards, checked {clock(checkedAt)}.{' '}
          <Link to="/runs">See what happens next</Link>
        </p>
      </div>
    </div>
  );
}

const SEEN_KEY = 'fw.rewards.cargo.seen';
function seen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/** Cargo landed: a row's probe passed on the merged code. Shown once per row per browser. */
export function CargoLanded({
  rowId,
  ledgerRowId,
  title,
  sha,
}: {
  rowId: string;
  ledgerRowId: string;
  title: string;
  sha: string;
}) {
  const still = useStill();
  const [show, setShow] = useState(() => !seen().has(ledgerRowId));
  useEffect(() => {
    if (!show) return;
    const s = seen();
    s.add(ledgerRowId);
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify([...s].slice(-500)));
    } catch {
      /* ignore */
    }
  }, [show, ledgerRowId]);
  if (!show) return null;
  return (
    <span className="reward small" role="status">
      <span className={still ? '' : 'reward-mark'}>
        <Icon name="pass" />
      </span>
      <span>
        Cargo landed: {rowId} {title}. Probe passed on <span className="mono">{sha.slice(0, 7)}</span>.{' '}
        <Link to={`/ledger/${ledgerRowId}#probe`}>Evidence</Link>{' '}
        <button type="button" className="btn btn-quiet" onClick={() => setShow(false)}>
          Dismiss
        </button>
      </span>
    </span>
  );
}
