// FW-C-066: the flow's drafts as an inbox. Every drafted message is listed on the left with who it is for,
// its state and its age; the selected one is shown in full on the right with the editor, Rewrite with AI,
// Approve, Reject and the after-you-send buttons (DraftEditor). FW-C-077: plain white, no avatars, a tinted
// selected row. Nothing here sends anything.
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../api/client';
import { useResource } from '../api/resource';
import type { FlowDraft } from '../api/types';
import { IconTile } from '../ui-kit/flow';
import { AsOf, ResourceView } from '../ui-kit/honest';
import { DraftEditor } from './DraftEditor';
import { ageOf, type DraftState, inboxOrder, recipientOf, stateOf } from './drafts';
import { DraftBars, ReplyMeter, StatePill, TONE } from './FlowVisuals';

type Filter = 'all' | 'ready' | 'blanks' | 'sent' | 'done';
const FILTERS: { key: Filter; label: string; has: (s: DraftState) => boolean }[] = [
  { key: 'all', label: 'All', has: () => true },
  { key: 'ready', label: 'Ready', has: (s) => s === 'Ready' },
  { key: 'blanks', label: 'Has blanks', has: (s) => s === 'Has blanks' },
  { key: 'sent', label: 'Sent', has: (s) => s === 'Sent' || s === 'Replied' || s === 'Said no' },
  { key: 'done', label: 'Handled', has: (s) => s === 'Approved' || s === 'Rejected' },
];

const CHANNEL: Record<string, string> = {
  founder_email: 'your email',
  frequency: 'Frequency',
  email: 'email',
};

const who = (d: FlowDraft) => recipientOf(d) ?? d.subject ?? 'Untitled draft';
const snippet = (d: FlowDraft) => {
  const text = d.body.replace(/\s+/g, ' ').trim();
  const r = recipientOf(d);
  const rest = r ? text.replace(/^\S+\s+[^,\n!.]+[,!.]\s*/, '') : text;
  return rest.length > 110 ? `${rest.slice(0, 108)}…` : rest;
};

function Inbox({
  flow,
  drafts,
  sender,
  onChanged,
}: {
  flow: string;
  drafts: FlowDraft[];
  sender: boolean;
  onChanged: () => void;
}) {
  const ordered = useMemo(() => inboxOrder(drafts), [drafts]);
  const [filter, setFilter] = useState<Filter>('all');
  const shown = ordered.filter((d) => FILTERS.find((f) => f.key === filter)?.has(stateOf(d)));
  const [picked, setPicked] = useState<string | null>(null);
  const selected = shown.find((d) => d.id === picked) ?? shown[0] ?? null;
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const optId = (d: FlowDraft) => `${listId}-${d.id}`;

  useEffect(() => {
    // Keep the selected draft in view inside the list only; never scroll the page.
    const list = listRef.current;
    const el = selected ? document.getElementById(`${listId}-${selected.id}`) : null;
    if (!list || !el) return;
    if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop - 8;
    else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight + 8;
  }, [selected, listId]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!shown.length) return;
    const at = selected ? shown.indexOf(selected) : -1;
    const to =
      e.key === 'ArrowDown'
        ? Math.min(shown.length - 1, at + 1)
        : e.key === 'ArrowUp'
          ? Math.max(0, at - 1)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? shown.length - 1
              : null;
    if (to == null) return;
    e.preventDefault();
    setPicked(shown[to].id);
  };

  const count = (f: (typeof FILTERS)[number]) => ordered.filter((d) => f.has(stateOf(d))).length;
  const s = selected ? stateOf(selected) : null;
  return (
    <>
      <fieldset className="inbox-filters">
        <legend className="visually-hidden">Show drafts</legend>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`inbox-filter${filter === f.key ? ' is-on' : ''}`}
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
          >
            {f.label} <span className="inbox-filter-n">{count(f)}</span>
          </button>
        ))}
      </fieldset>
      <div className="inbox">
        <div
          ref={listRef}
          className="inbox-list"
          role="listbox"
          aria-label="All drafts"
          tabIndex={0}
          aria-activedescendant={selected ? optId(selected) : undefined}
          onKeyDown={onKey}
        >
          {shown.length === 0 && <p className="inbox-none muted">Nothing here.</p>}
          {shown.map((d) => {
            const st = stateOf(d);
            const on = d.id === selected?.id;
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox takes the arrow keys for its options
              <div
                key={d.id}
                id={optId(d)}
                role="option"
                tabIndex={-1}
                aria-selected={on}
                className={`inbox-item${on ? ' is-on' : ''} is-${TONE[st]}`}
                onClick={() => {
                  setPicked(d.id);
                  listRef.current?.focus();
                }}
              >
                <span className="inbox-item-top">
                  <span className="inbox-item-who">{who(d)}</span>
                  <span className="inbox-item-age">{ageOf(d.sent_at ?? d.created_at)}</span>
                </span>
                <span className="inbox-item-subject">{d.subject ?? 'Untitled draft'}</span>
                <span className="inbox-item-snippet">{snippet(d)}</span>
                <StatePill s={st} />
              </div>
            );
          })}
        </div>
        <section className="inbox-viewer" aria-label="Draft viewer">
          {selected && s ? (
            <>
              <header className="viewer-head">
                <div className="viewer-line">
                  <span className="viewer-who">{recipientOf(selected) ?? 'No name found'}</span>
                  <StatePill s={s} />
                </div>
                <h3>{selected.subject ?? 'Untitled draft'}</h3>
                <span className="viewer-meta">
                  Drafted {ageOf(selected.created_at) || 'at an unknown time'}
                  {selected.created_at && ageOf(selected.created_at) !== 'now' ? ' ago' : ''}
                  {selected.channel ? ` · send by ${CHANNEL[selected.channel] ?? selected.channel}` : ''}
                </span>
              </header>
              <DraftEditor
                key={selected.id}
                flow={flow}
                draft={selected}
                sender={sender}
                onChanged={onChanged}
              />
            </>
          ) : (
            <div className="viewer-empty">
              <IconTile name="inbox" size="lg" />
              <p className="muted">Pick a draft on the left to read it here.</p>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

/** The drafts panel on the Flows page: a header with recent activity, then the two-pane inbox. */
export function DraftsInbox({ flow }: { flow: string }) {
  const res = useResource(`flow-drafts:${flow}`, () => api.flowDrafts(flow), ['runs']);
  // FW-C-071: Approve only when a sender on the Mac reads the outbox; until it is known, assume none.
  const sup = useResource('supervisor', () => api.supervisor(), ['runs', 'cards']);
  const sender = sup.data?.sender?.installed === true;
  const head = useId();
  const all = res.data?.drafts ?? [];
  const ready = all.filter((d) => stateOf(d) === 'Ready').length;
  const cliOnly = res.error instanceof ApiError && res.error.status === 403;
  return (
    <section className="panel inbox-panel" aria-labelledby={head}>
      <div className="inbox-head">
        <IconTile name="mail" tone={ready > 0 ? 'waiting' : 'neutral'} />
        <div className="inbox-head-text">
          <h2 id={head}>Drafts</h2>
          <span className="muted small">
            {res.data ? (
              ready > 0 ? (
                `${ready} ready for you to check and send`
              ) : (
                'Nothing waiting on you'
              )
            ) : (
              <AsOf res={res} />
            )}
          </span>
        </div>
        {all.length > 0 && (
          <div className="inbox-activity">
            <DraftBars drafts={all} />
            <ReplyMeter drafts={all} />
          </div>
        )}
      </div>
      {cliOnly ? (
        <p className="muted">
          On this machine, list drafts with <code>pnpm fw supervisor drafts {flow}</code>. flowweb.app shows
          them here.
        </p>
      ) : (
        <ResourceView res={res} what="the drafts">
          {(d) =>
            d.drafts.length === 0 ? (
              <div className="viewer-empty">
                <IconTile name="inbox" size="lg" />
                <p className="muted">No drafts yet. They appear here after the flow runs.</p>
              </div>
            ) : (
              <Inbox flow={flow} drafts={d.drafts} sender={sender} onChanged={res.reload} />
            )
          }
        </ResourceView>
      )}
    </section>
  );
}
