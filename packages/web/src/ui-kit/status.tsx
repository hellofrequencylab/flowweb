import type { CheckStatus, ProbeStatus, RowStatus, RunStatus } from '../api/types';
import { Icon, type IconName } from './Icon';
import { clock } from './time';

export type Tone = 'ok' | 'fail' | 'warn' | 'unknown' | 'neutral' | 'attention' | 'active' | 'stop';

export interface StatusSpec {
  word: string;
  tone: Tone;
  icon: IconName;
}

/** A status is always a shape and a word. Colour only reinforces. */
export function StatusLabel({
  spec: given,
  detail,
  plain = false,
}: {
  /** Undefined when the server sent a value this UI has no word for; shown as unknown, never a crash. */
  spec: StatusSpec | undefined;
  detail?: string;
  /** Icon and word only, without the tinted pill (for dense rows). */
  plain?: boolean;
}) {
  const spec = given ?? UNKNOWN_STATUS;
  return (
    <span className={`status status-${spec.tone}${plain ? ' status-plain' : ''}`}>
      <span className="status-icon">
        <Icon name={spec.icon} />
      </span>
      <span>{spec.word}</span>
      {detail && <span className="status-detail">· {detail}</span>}
    </span>
  );
}

/** What StatusLabel shows for a value it has no word for. */
export const UNKNOWN_STATUS: StatusSpec = { word: 'Unknown status', tone: 'unknown', icon: 'notverified' };

export const ROW_STATUS: Record<RowStatus, StatusSpec> = {
  open: { word: 'Open', tone: 'neutral', icon: 'open' },
  ready: { word: 'Ready', tone: 'neutral', icon: 'ready' },
  claimed: { word: 'Claimed', tone: 'active', icon: 'waiting' },
  running: { word: 'Running', tone: 'active', icon: 'running' },
  verifying: { word: 'Verifying', tone: 'active', icon: 'checking' },
  awaiting_approval: { word: 'Waiting for you', tone: 'attention', icon: 'waiting' },
  merging: { word: 'Merging', tone: 'active', icon: 'running' },
  watching: { word: 'Merged, watching (not verified)', tone: 'unknown', icon: 'notverified' },
  done: { word: 'Done (verified)', tone: 'ok', icon: 'done' },
  blocked: { word: 'Blocked', tone: 'warn', icon: 'blocked' },
  parked: { word: 'Parked', tone: 'neutral', icon: 'paused' },
  regressed: { word: 'Regressed', tone: 'fail', icon: 'fail' },
};

/**
 * "Running" is only true while the agent's heartbeat is fresh. Without one the
 * UI says when it last heard from it.
 */
export function runStatusSpec(
  status: RunStatus,
  heartbeatAt?: string,
  now = Date.now(),
): StatusSpec & { detail?: string } {
  switch (status) {
    case 'queued':
      return { word: 'Queued', tone: 'neutral', icon: 'clock' };
    case 'starting':
      return { word: 'Starting', tone: 'active', icon: 'clock' };
    case 'running': {
      // Agreed with Core: Running only while the lease heartbeat is under 120 s old.
      const fresh = heartbeatAt && now - new Date(heartbeatAt).getTime() < 120_000;
      if (fresh) return { word: 'Running', tone: 'active', icon: 'running' };
      return {
        word: heartbeatAt ? `No signal since ${clock(heartbeatAt)}` : 'No signal',
        tone: 'unknown',
        icon: 'unknown',
      };
    }
    case 'paused':
      return { word: 'Paused', tone: 'neutral', icon: 'paused' };
    case 'checking':
      return { word: 'Checking', tone: 'active', icon: 'checking' };
    case 'finished_unchecked':
      return { word: 'Finished, not checked', tone: 'unknown', icon: 'notverified' };
    case 'artifact_verified':
      return { word: 'Artifact verified', tone: 'ok', icon: 'verified' };
    case 'claimed_unverified':
      return { word: 'Claimed done, not verified', tone: 'unknown', icon: 'notverified' };
    case 'failed':
      return { word: 'Failed', tone: 'fail', icon: 'fail' };
    case 'timed_out':
      return { word: 'Timed out', tone: 'fail', icon: 'clock' };
    case 'halted':
      return { word: 'Halted by you', tone: 'neutral', icon: 'halted' };
    case 'cancelled':
      return { word: 'Cancelled', tone: 'neutral', icon: 'skipped' };
  }
}

export const CHECK_STATUS: Record<CheckStatus, StatusSpec> = {
  pass: { word: 'Pass', tone: 'ok', icon: 'pass' },
  fail: { word: 'Fail', tone: 'fail', icon: 'fail' },
  warn: { word: 'Warning', tone: 'warn', icon: 'warn' },
  // Skipped is never a pass.
  skipped: { word: 'Skipped, not verified', tone: 'unknown', icon: 'notverified' },
  pending: { word: 'Loading', tone: 'unknown', icon: 'clock' },
};

export const PROBE_STATUS: Record<ProbeStatus, StatusSpec> = {
  pass: { word: 'Pass', tone: 'ok', icon: 'pass' },
  fail: { word: 'Fail', tone: 'fail', icon: 'fail' },
  error: { word: 'Error', tone: 'warn', icon: 'warn' },
  never: { word: 'Not verified (never ran)', tone: 'unknown', icon: 'notverified' },
};

/** A probe pass on a branch is not a pass on the merged code. */
export function probeSpec(status: ProbeStatus, target?: string): StatusSpec {
  if (status === 'pass' && target && target !== 'merged' && target !== 'deployed') {
    return { word: `Pass on ${target}, not verified on merged code`, tone: 'unknown', icon: 'notverified' };
  }
  return PROBE_STATUS[status];
}

export const VERDICT: Record<'concur' | 'concerns' | 'reject', StatusSpec> = {
  concur: { word: 'Agrees', tone: 'ok', icon: 'pass' },
  concerns: { word: 'Concerns', tone: 'warn', icon: 'concerns' },
  reject: { word: 'Rejects', tone: 'fail', icon: 'fail' },
};

// fwd reports "absent" when a run had no sandbox at all: that is no egress control either.
export const SANDBOX: Record<'enforced' | 'best_effort' | 'none' | 'absent', StatusSpec> = {
  enforced: { word: 'Egress enforced', tone: 'ok', icon: 'verified' },
  best_effort: { word: 'Egress best effort', tone: 'warn', icon: 'warn' },
  none: { word: 'No sandbox egress control', tone: 'fail', icon: 'fail' },
  absent: { word: 'No sandbox egress control', tone: 'fail', icon: 'fail' },
};
