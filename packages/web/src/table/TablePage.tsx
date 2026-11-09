import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useResource } from '../api/resource';
import type { CardSummary } from '../api/types';
import { TableCleared } from '../rewards/Rewards';
import { chordPending, useKeys } from '../shell/keys';
import { usePrefs } from '../shell/prefs';
import { useRouter } from '../shell/router';
import { AsOf, Empty, LoadError, Loading, StaleNotice } from '../ui-kit/honest';
import { Icon } from '../ui-kit/Icon';
import { PageHead } from '../ui-kit/page';
import { age, clock, useNow, when } from '../ui-kit/time';
import { CardView, type Decided } from './CardView';

export const VARIANT_LABEL: Record<CardSummary['variant'], string> = {
  approve: 'Approve or deny',
  choose: 'Choose',
  answer: 'Answer',
  review: 'Review',
  unblock: 'Unblock',
};

/** Progress through today's table, kept per browser tab. */
function useSessionProgress() {
  const key = 'fw.table.session';
  const read = () => {
    try {
      const v = JSON.parse(sessionStorage.getItem(key) ?? 'null') as {
        day: string;
        answered: number;
        startedAt: string;
      } | null;
      if (v && v.day === new Date().toDateString()) return v;
    } catch {
      /* ignore */
    }
    return { day: new Date().toDateString(), answered: 0, startedAt: new Date().toISOString() };
  };
  const [p, setP] = useState(read);
  const bump = () =>
    setP((o) => {
      const n = { ...o, answered: o.answered + 1 };
      try {
        sessionStorage.setItem(key, JSON.stringify(n));
      } catch {
        /* ignore */
      }
      return n;
    });
  return { ...p, bump };
}

export function TablePage({ cardId }: { cardId?: string }) {
  const list = useResource('cards', api.cards, ['cards']);
  const { go } = useRouter();
  const { prefs } = usePrefs();
  const now = useNow();
  const progress = useSessionProgress();
  const [showEvidence, setShowEvidence] = useState(true);
  const [last, setLast] = useState<Decided | null>(null);
  const [cleared, setCleared] = useState<{ count: number; minutes: number } | null>(null);
  const queueRef = useRef<HTMLOListElement>(null);

  const cards = list.data?.cards ?? [];
  const selected = cardId ?? cards[0]?.id;
  const idx = cards.findIndex((c) => c.id === selected);

  // Keep the URL on a real card once the list is known.
  useEffect(() => {
    if (!cardId && cards[0] && list.honesty === 'current') go(`/table/${cards[0].id}`);
  }, [cardId, cards, list.honesty, go]);

  useKeys(
    {
      j: () => {
        if (chordPending()) return;
        const n = cards[Math.min(cards.length - 1, idx + 1)];
        if (n) go(`/table/${n.id}`);
      },
      k: () => {
        const n = cards[Math.max(0, idx - 1)];
        if (n) go(`/table/${n.id}`);
      },
      enter: (e) => {
        if ((e.target as HTMLElement).closest('button, a, input, textarea, select')) return;
        document.getElementById('card-heading')?.focus();
      },
      e: () => setShowEvidence((v) => !v),
    },
    prefs.shortcuts,
  );

  const onDecided = (d: Decided) => {
    setLast(d);
    progress.bump();
    const remaining = cards.filter((c) => c.id !== d.cardId);
    list.reload();
    if (remaining.length > 0) {
      const next = remaining[Math.min(idx, remaining.length - 1)];
      go(`/table/${next.id}`);
    } else {
      // Table cleared: fired from fwd confirming the answer, not from a click alone.
      setCleared({
        count: progress.answered + 1,
        minutes: Math.max(1, Math.round((Date.now() - Date.parse(progress.startedAt)) / 60000)),
      });
      go('/table');
    }
  };

  const total = progress.answered + cards.length;

  return (
    <>
      <PageHead
        overline="Decisions waiting on you"
        title="Captain's Table"
        lede={
          <>
            {list.honesty === 'current' && cards.length > 0
              ? `Card ${Math.min(progress.answered + 1, total)} of ${total} today. Nothing moves until you answer.`
              : 'Every decision FlowWeb needs from you, one at a time.'}
            <span className="page-meta">
              <AsOf res={list} />
            </span>
          </>
        }
      />

      {last && (
        <div className="callout callout-ok callout-row callout-block" role="status">
          <Icon name="check" size={18} />
          <p>
            {last.summary} Recorded {clock(last.at)}.
          </p>
        </div>
      )}

      {list.honesty === 'loading' && <Loading what="the table" />}
      {!list.data && list.honesty !== 'loading' && (
        <LoadError what="the decision cards" error={list.error} onRetry={list.reload} />
      )}
      {list.data && list.honesty === 'stale' && <StaleNotice res={list} what="list of cards" />}

      {/* The empty state only when fwd confirms zero; a load failure never shows it. */}
      {list.data && list.honesty === 'current' && cards.length === 0 && (
        <div className="stack">
          {cleared && prefs.rewards && prefs.rewardTableCleared ? (
            <TableCleared count={cleared.count} minutes={cleared.minutes} checkedAt={list.asOf!} />
          ) : (
            <Empty title="Table's clear.">
              Nothing needs you. <span className="muted">Checked {clock(list.asOf)}.</span>
            </Empty>
          )}
        </div>
      )}

      {list.data && cards.length > 0 && (
        <div className="table-layout">
          {selected && (
            <nav className="row show-narrow queue-steps" aria-label="Move between cards">
              <button
                type="button"
                className="btn btn-small"
                disabled={idx <= 0}
                onClick={() => go(`/table/${cards[idx - 1].id}`)}
              >
                <Icon name="arrow-left" /> Previous
              </button>
              <span className="muted small">
                Queue position {idx + 1} of {cards.length}
              </span>
              <button
                type="button"
                className="btn btn-small"
                disabled={idx < 0 || idx >= cards.length - 1}
                onClick={() => go(`/table/${cards[idx + 1].id}`)}
              >
                Next <Icon name="arrow-right" />
              </button>
            </nav>
          )}
          <nav aria-label="Waiting cards" className={selected ? 'hide-narrow' : ''}>
            <ol className="queue" ref={queueRef}>
              {cards.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className="queue-item"
                    aria-current={c.id === selected ? 'true' : undefined}
                    onClick={() => go(`/table/${c.id}`)}
                  >
                    <span className="queue-kind">
                      <Icon name="waiting" size={13} />
                      {VARIANT_LABEL[c.variant]}
                      {c.row_id ? ` · ${c.row_id}` : ''}
                    </span>
                    <span className="queue-title">{c.title}</span>
                    <span className="xs muted">
                      {c.project_name ? `${c.project_name} · ` : ''}waiting{' '}
                      {age(c.created_at, now).replace(' ago', '')}
                      {c.deadline_at ? ` · due ${when(c.deadline_at, now)}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          {selected ? (
            <CardView
              key={selected}
              id={selected}
              showEvidence={showEvidence}
              onToggleEvidence={() => setShowEvidence((v) => !v)}
              onDecided={onDecided}
            />
          ) : null}
        </div>
      )}
    </>
  );
}
