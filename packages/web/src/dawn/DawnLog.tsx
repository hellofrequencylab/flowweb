import { api } from '../api/client';
import { useLive, useStatusResource } from '../api/live';
import { type Resource, useResource } from '../api/resource';
import type { DawnLog as Dawn, Status } from '../api/types';
import { UNREACHABLE } from '../hosted/auth';
import { Icon } from '../ui-kit/Icon';
import { PageHead } from '../ui-kit/page';
import { clock, useNow } from '../ui-kit/time';
import { Today } from './Today';

function greeting(now: number) {
  const h = new Date(now).getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/**
 * Home. In about five seconds: is anything wrong, what waits on you, how the open region is doing,
 * and whether each flow is working. The build tracker lives in BuildOverview.
 */
export function DawnLog() {
  const dawn = useResource('dawn', api.dawn, ['dawn', 'rows', 'runs']);
  const st = useStatusResource();
  const { connection } = useLive();
  const now = useNow();

  return (
    <div className="today-page">
      <PageHead script={greeting(now)} title="Today" lede={<Headline res={dawn} />} />
      <Problems status={st.data} down={connection === 'down'} />
      <Today status={st} now={now} />
    </div>
  );
}

/** Today's digest headline, as one line. */
function Headline({ res }: { res: Resource<Dawn> }) {
  const d = res.data;
  if (!d)
    return (
      <span className="muted">
        {res.honesty === 'loading' ? 'Reading today.' : 'Digest Unknown until fwd answers.'}
      </span>
    );
  if (!d.digest) return <span className="muted">No digest yet today.</span>;
  if (!d.digest.self_check_ok)
    return <span className="muted">Today's digest failed its own check, so it is not shown.</span>;
  return (
    <>
      <span className="today-headline">{d.digest.headline}</span>{' '}
      <span className="asof">Digest {clock(d.digest.produced_at)}</span>
    </>
  );
}

/** Problems line: only when something is wrong, first thing on the page. */
export function Problems({ status: s, down }: { status: Status | null; down: boolean }) {
  const items: string[] = [];
  if (down) items.push(`${UNREACHABLE}. Every value below is Unknown.`);
  if (s?.kill_switch.state === 'stopped')
    items.push(`Kill switch engaged at ${clock(s.kill_switch.engaged_at)}.`);
  if (s?.kill_switch.state === 'stopping') items.push('Kill switch: stopping, not yet confirmed.');
  if (s?.breaker?.tripped) items.push(`Budget breaker tripped: ${s.breaker.reason ?? 'no reason given'}.`);
  else if (s?.paused_by_budget) items.push('Paused: daily budget reached.');
  if (s && !s.integrity.ok)
    items.push(
      `Event log integrity check failed${s.integrity.failed_at_seq ? ` at #${s.integrity.failed_at_seq}` : ''}.`,
    );
  if (s?.sandbox_egress && s.sandbox_egress !== 'enforced')
    items.push(
      `Sandbox not fully enforced (egress ${s.sandbox_egress === 'best_effort' ? 'best effort' : 'none'}).`,
    );
  if (items.length === 0) return null;
  return (
    <div className="callout callout-fail callout-block" role="alert">
      <strong className="callout-title">
        <Icon name="problem" size={18} /> Problems
      </strong>
      <ul>
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}
