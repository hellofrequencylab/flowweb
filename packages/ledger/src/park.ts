// Parking a row by hand (FW-C-067 follow-up). The schema already lets the Owner park a row with a
// reason (open, ready, running, awaiting_approval, regressed or blocked -> parked); this is the door
// to it. A parked row is not claimable and is not counted as open work. It can be unparked later
// (parked -> open or ready) or closed if its probe passes on a merged commit (parked -> done).
import type { Writer } from '@fw/eventlog';
import { type Actor, ownerActor } from './bootstrap.ts';
import { LedgerError } from './errors.ts';
import { transitionRow } from './fsm.ts';
import type { RowStatus } from './rows.ts';

export interface ParkReport {
  code: string;
  from: RowStatus;
  to: 'parked';
  reason: string;
  event_id: string;
}

export function parkRow(w: Writer, code: string, opts: { reason: string; actor?: Actor }): ParkReport {
  const reason = (opts.reason ?? '').trim();
  if (reason.length < 3 || reason.length > 500)
    throw new LedgerError('BAD_ARGUMENT', 'a parked row needs a reason of 3 to 500 characters');
  const actor = opts.actor ?? ownerActor(w);
  const t = transitionRow(w, code, 'parked', {
    actor,
    guard_evidence: { reason: 'owner_parked', note: reason },
  });
  return { code: t.code, from: t.from, to: 'parked', reason, event_id: t.event_id };
}
