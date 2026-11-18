// FW-C-168: the weekly review's proposed shifts as short proposals the Owner accepts or declines one at a
// time. A pause is one proposal. Every max_sends move of a review is one proposal together, because the
// moves only keep the enabled hunts' total from rising when they are all taken. Accept applies the shifts
// through the review's own code (decideShift), so it can pause a hunt or move sends between hunts and
// nothing else: no cap, region or policy changes and nothing is sent. Decline dismisses them and records
// it, so the next reviews do not raise the same proposal again for 30 days.
import { appendAdminLog } from './neighborhood-admin.ts';
import {
  DECLINE_DAYS,
  decideShift,
  declineKey,
  type HuntCard,
  ReviewError,
  readReview,
  recordDecline,
  type Shift,
} from './review.ts';

export type Proposal = {
  id: string;
  kind: 'pause' | 'move';
  /** One plain line saying what accepting does. */
  text: string;
  evidence: {
    pooled_rate: number | null;
    hunts: { name: string; sent: number; responded: number; from: number | null; to: number | null }[];
  };
  state: 'open' | 'accepted' | 'declined';
};
type Grouped = Proposal & { shifts: Shift[]; key: string };

function stateOf(shifts: Shift[]): Proposal['state'] {
  if (shifts.some((s) => s.status === 'proposed')) return 'open';
  return shifts.some((s) => s.status === 'applied') ? 'accepted' : 'declined';
}

function grouped(home: string): Grouped[] {
  const review = readReview(home);
  const shifts = Array.isArray(review?.shifts) ? review.shifts : [];
  const cards = new Map<string, HuntCard>((review?.scorecard?.hunts ?? []).map((c) => [c.hunt_id, c]));
  const pooled = review?.scorecard?.pooled_rate ?? null;
  const row = (s: Shift) => {
    const c = cards.get(s.hunt_id);
    const n = (v: number | boolean) => (typeof v === 'number' ? v : null);
    return {
      name: c?.name ?? s.hunt_id,
      sent: c?.sent ?? 0,
      responded: c?.responded ?? 0,
      from: n(s.from),
      to: n(s.to),
    };
  };
  const make = (kind: Proposal['kind'], list: Shift[], text: string): Grouped => ({
    id: (list[0] as Shift).id,
    kind,
    text,
    evidence: { pooled_rate: pooled, hunts: list.map(row) },
    state: stateOf(list),
    shifts: list,
    key: declineKey(
      list.map((s) => s.kind)[0] as string,
      list.map((s) => s.hunt_id),
    ),
  });
  const out = shifts
    .filter((s) => s.kind === 'pause')
    .map((s) => make('pause', [s], `Pause the hunt "${row(s).name}": ${row(s).sent} sent and nothing back.`));
  const moves = shifts.filter((s) => s.kind === 'max_sends');
  if (moves.length > 0) {
    const parts = moves.map((s) => `"${row(s).name}" from ${s.from} to ${s.to} a run`);
    out.push(make('move', moves, `Move sends toward the hunts that get replies: ${parts.join(', ')}.`));
  }
  return out;
}

const view = ({ shifts: _s, key: _k, ...p }: Grouped): Proposal => p;

/** The last review's proposals for the flow whose home this is. No review reads as none. */
export function proposalsOf(home: string): Proposal[] {
  return grouped(home).map(view);
}

/** The Owner accepts or declines one open proposal of the last review. */
export function decideProposal(
  home: string,
  id: string,
  decision: 'accept' | 'decline',
  now = new Date(),
): Proposal {
  const p = grouped(home).find((x) => x.id === id);
  if (!p) throw new ReviewError(404, `the last review has no proposal ${id}`);
  if (p.state !== 'open') throw new ReviewError(409, `this proposal is already ${p.state}`);
  for (const s of p.shifts)
    if (s.status === 'proposed') decideShift(home, s.id, decision === 'accept' ? 'apply' : 'dismiss', now);
  if (decision === 'decline') {
    recordDecline(home, p.key, now);
    appendAdminLog(home, {
      at: now.toISOString(),
      action: 'hunt',
      summary: `Declined a weekly review proposal, so it is not raised again for ${DECLINE_DAYS} days: ${p.text}`,
    });
  }
  return (
    grouped(home)
      .map(view)
      .find((x) => x.id === id) ?? view(p)
  );
}
