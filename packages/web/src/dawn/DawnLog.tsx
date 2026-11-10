import { api } from '../api/client';
import { useLive, useStatusResource } from '../api/live';
import { useResource } from '../api/resource';
import type { CardSummary, DawnLog as Dawn, Status } from '../api/types';
import { UNREACHABLE } from '../hosted/auth';
import { Link } from '../shell/router';
import { AsOf, Empty, Fact, LoadError, Loading, StaleNotice } from '../ui-kit/honest';
import { Icon } from '../ui-kit/Icon';
import { type FigureItem, Figures, PageHead } from '../ui-kit/page';
import { age, clock, usd, useNow, when } from '../ui-kit/time';
import { BuildOverview } from './BuildOverview';

function greeting(now: number) {
  const h = new Date(now).getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

const unknown = <span className="fact-unknown">Unknown</span>;

/** Home. In under a minute: what happened, what needs you, whether anything is stopped or wrong. */
export function DawnLog() {
  const dawn = useResource('dawn', api.dawn, ['dawn', 'rows', 'runs']);
  const st = useStatusResource();
  const cardsRes = useResource('cards', api.cards, ['cards']);
  const { connection } = useLive();
  const now = useNow();
  const s = st.data;
  const d = dawn.data;
  const live = st.honesty === 'current' && s;
  const honest = dawn.honesty === 'current' && st.honesty === 'current';

  const figures: FigureItem[] = [
    {
      label: d ? `done since ${when(d.since, now)}` : 'done',
      value: d && honest ? d.rows_done.length : unknown,
    },
    live
      ? {
          label: s.cards_open === 1 ? 'needs you' : 'need you',
          value: s.cards_open,
          tone: s.cards_open > 0 ? 'waiting' : undefined,
        }
      : { label: 'need you', value: unknown },
    d && honest && d.runs.failed > 0
      ? { label: 'runs failed', value: d.runs.failed, tone: 'fail' }
      : { label: 'runs finished', value: d && honest ? d.runs.total : unknown },
    live && s.spend_today
      ? {
          label: s.spend_today.estimated ? 'spent today, estimated' : 'spent today',
          value: usd(s.spend_today.usd),
          of: `of ${usd(s.spend_today.cap_usd)}`,
        }
      : { label: 'spent today', value: unknown },
  ];

  return (
    <>
      <PageHead
        script={greeting(now)}
        title="Console"
        lede={
          <>
            {d ? <Summary d={d} s={s} honest={honest} /> : <span>Summary unknown until fwd answers.</span>}
            <span className="page-meta">
              {d?.digest?.self_check_ok && <span className="asof">Digest {clock(d.digest.produced_at)}</span>}
              <AsOf res={dawn} label="Live counts as of" />
            </span>
          </>
        }
        aside={<Figures items={figures} label="Today at a glance" />}
      />

      <Problems status={s} down={connection === 'down'} />

      {dawn.honesty === 'loading' && <Loading what="today's log" />}
      {!d && dawn.honesty !== 'loading' && (
        <LoadError what="today's log" error={dawn.error} onRetry={dawn.reload} />
      )}
      {d && dawn.honesty === 'stale' && <StaleNotice res={dawn} what="log" />}

      {d && (
        <>
          <DigestNote d={d} />

          <NeedsStrip
            res={st}
            now={now}
            cards={cardsRes.honesty === 'current' ? cardsRes.data?.cards : undefined}
          />

          {isQuiet(d, s) && dawn.honesty === 'current' ? (
            <Empty title="All quiet">
              Nothing changed since {clock(d.since)}. Checked: logs, runs, spend, sign-offs.
            </Empty>
          ) : null}
        </>
      )}

      <BuildOverview />
    </>
  );
}

/** The saffron "needs you" strip. Saffron means one thing: waiting on you. */
function NeedsStrip({
  res,
  now,
  cards,
}: {
  res: ReturnType<typeof useStatusResource>;
  now: number;
  cards?: CardSummary[];
}) {
  const s = res.data;
  if (res.honesty !== 'current' || !s)
    return (
      <div className="needs-strip needs-strip-unknown">
        <span className="needs-strip-label">
          Needs you: <Fact res={res} pick={(x: Status) => x.cards_open} />
        </span>
      </div>
    );
  if (s.cards_open === 0)
    return (
      <div className="needs-strip needs-strip-clear">
        <Icon name="check" size={18} />
        <span>
          Nothing is waiting. <span className="muted">Checked {clock(s.data_as_of)}.</span>
        </span>
      </div>
    );
  const n = s.cards_open;
  return (
    <section className="needs-strip" aria-label="Needs you">
      <span className="needs-strip-mark" aria-hidden="true">
        <Icon name="waiting" size={17} />
      </span>
      <span className="needs-strip-label">
        {n} card{n === 1 ? '' : 's'} need{n === 1 ? 's' : ''} you
        {s.oldest_card_created_at && (
          <span className="muted">
            {' '}
            · oldest waited {age(s.oldest_card_created_at, now).replace(' ago', '')}
          </span>
        )}
      </span>
      {cards && cards.length > 0 && (
        <ul className="needs-chips">
          {cards
            .filter((c) => c.state === 'open')
            .slice(0, 3)
            .map((c) => (
              <li key={c.id}>
                <Link to={`/table/${c.id}`} className="needs-chip">
                  <span className="needs-chip-title">{c.title}</span>
                  <span className="muted">{age(c.created_at, now).replace(' ago', '')}</span>
                </Link>
              </li>
            ))}
        </ul>
      )}
      <Link to="/table" className="btn btn-primary">
        Open Sign-offs <Icon name="arrow-right" />
      </Link>
    </section>
  );
}

function isQuiet(d: Dawn, s: Status | null) {
  return (
    d.rows_done.length === 0 &&
    d.rows_watching.length === 0 &&
    d.runs.total === 0 &&
    (s?.cards_open ?? 0) === 0
  );
}

function DigestNote({ d }: { d: Dawn }) {
  if (!d.digest) return <p className="small muted">No digest yet for today. Showing live counts.</p>;
  if (!d.digest.self_check_ok)
    return (
      <p className="callout callout-warn callout-block" role="status">
        Today's digest failed its own check. Showing live counts instead.
      </p>
    );
  return null;
}

function Summary({ d, s, honest }: { d: Dawn; s: Status | null; honest: boolean }) {
  if (!honest) return <span>Summary unknown until fwd answers.</span>;
  const parts = [
    `${d.rows_done.length} row${d.rows_done.length === 1 ? '' : 's'} done since ${when(d.since)}.`,
  ];
  if (s)
    parts.push(
      s.cards_open === 0
        ? 'Nothing needs you.'
        : `${s.cards_open} card${s.cards_open === 1 ? '' : 's'} need${s.cards_open === 1 ? 's' : ''} you.`,
    );
  if (s?.spend_today) parts.push(`Spend ${usd(s.spend_today.usd)} of ${usd(s.spend_today.cap_usd)}.`);
  return <span>{parts.join(' ')}</span>;
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
