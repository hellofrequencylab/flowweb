// FW-C-105: Today. The morning's ranked list of actions, worked in about 20 minutes: copy a draft and open
// where it goes, send it by hand, mark it sent, edit it or skip it with one tap. Keys on the list: J and K
// move, C copies and opens, S marks sent, E edits, X skips. Email touches go out together through Approve
// email batch. Plain white with hairlines, no avatars. Nothing here sends a DM or a form.
import { type KeyboardEvent, useId, useRef, useState } from 'react';
import { ApiError, api } from '../api/client';
import { useResource } from '../api/resource';
import type { TodayAction } from '../api/types';
import { Button } from '../ui-kit/Button';
import { AsOf } from '../ui-kit/honest';
import './today.css';

const KIND: Record<TodayAction['kind'], string> = {
  cold: 'First touch',
  sequence: 'Follow-up',
  warm: 'Warm follow-up',
  venue: 'Venue pitch',
  approve_lead: 'Lead to approve',
  show_up: 'Show up',
};
const ROUTE: Record<string, string> = { email: 'Email', dm: 'DM', form: 'Form', platform: 'Platform' };
const SKIPS = [
  ['wrong_niche', 'Wrong niche'],
  ['not_local', 'Not local'],
  ['not_a_fit', 'Not a fit'],
  ['on_frequency', 'Already on Frequency'],
] as const;

type Note = { tone: 'ok' | 'fail'; text: string } | null;
type Why = { id: string; reason: string };
/** What the last batch did with each draft: held for later or refused, with fwd's reason (FW-C-117). */
type Batch = { handed: string[]; held: Why[]; refused: Why[] } | null;
const whys = (v: unknown): Why[] =>
  Array.isArray(v)
    ? v.flatMap((x) =>
        x && typeof x === 'object' && typeof (x as Why).id === 'string'
          ? [{ id: (x as Why).id, reason: String((x as Why).reason ?? '') }]
          : [],
      )
    : [];
const failText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const facts = (a: TodayAction) =>
  [a.niche, a.town, a.route ? ROUTE[a.route] : null, a.words != null ? `${a.words} words` : null]
    .filter(Boolean)
    .join(' · ');

export function Today({ flow }: { flow: string }) {
  const res = useResource(`flow-today:${flow}`, () => api.flowToday(flow), ['runs']);
  const head = useId();
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const actions = res.data?.actions ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const [mode, setMode] = useState<'view' | 'skip' | 'edit'>('view');
  const [draftText, setDraftText] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const [batch, setBatch] = useState<Batch>(null);
  const at = Math.max(
    0,
    actions.findIndex((a) => a.id === picked),
  );
  const sel = actions[at] ?? null;
  const emailIds = actions.flatMap((a) => (a.route === 'email' && a.draft_id ? [a.draft_id] : []));
  const emailTo = actions.flatMap((a) => (a.route === 'email' && a.draft_id ? [a.to ?? a.name] : []));
  const nameOf = (id: string) => actions.find((a) => a.draft_id === id)?.to ?? id;

  const pick = (i: number) => {
    const a = actions[Math.min(actions.length - 1, Math.max(0, i))];
    if (a) setPicked(a.id);
    setMode('view');
  };
  async function run(work: () => Promise<unknown>, ok: (r: unknown) => string, next = true) {
    setBusy(true);
    setNote(null);
    try {
      const r = await work();
      setNote({ tone: 'ok', text: ok(r) });
      setMode('view');
      if (next && sel) setPicked(actions[at + 1]?.id ?? null);
      res.reload();
    } catch (e) {
      setNote({ tone: 'fail', text: failText(e) });
    } finally {
      setBusy(false);
      listRef.current?.focus();
    }
  }

  const copyOpen = (a: TodayAction) => {
    // Open first, inside the key press or click, so the browser does not block the new tab.
    if (a.open_url) window.open(a.open_url, '_blank', 'noopener');
    if (!a.body) return;
    navigator.clipboard
      ?.writeText(a.body)
      .then(() => setNote({ tone: 'ok', text: 'Copied. Paste it, send it, then mark it sent.' }))
      .catch(() =>
        setNote({ tone: 'fail', text: 'Your browser did not allow copying. Select the text instead.' }),
      );
  };
  const markSent = (a: TodayAction) =>
    a.draft_id &&
    run(
      () => api.draftChange(flow, a.draft_id as string, 'mark', { outcome: 'sent' }),
      () => 'Marked sent.',
    );
  const skip = (a: TodayAction, reason: string, label: string) =>
    a.draft_id &&
    run(
      () => api.draftChange(flow, a.draft_id as string, 'reject', { reason }),
      () => `Skipped: ${label}.`,
    );
  const save = (a: TodayAction) =>
    a.draft_id &&
    run(
      () => api.draftChange(flow, a.draft_id as string, 'edit', { body: draftText }),
      () => 'Saved.',
      false,
    );
  const edit = (a: TodayAction) => {
    if (!a.draft_id) return;
    setDraftText(a.body ?? '');
    setMode('edit');
  };
  const approveLead = (a: TodayAction) =>
    a.lead_id &&
    run(
      () => api.approveLead(flow, a.lead_id as string).catch(notYet('Lead approval')),
      () => 'Lead approved.',
    );
  const approveBatch = () =>
    run(
      () => api.approveEmailBatch(flow, emailIds).catch(notYet('Batch approval')),
      (r) => {
        const d = (r ?? {}) as Record<string, unknown>;
        const handed = Array.isArray(d.handed_off) ? d.handed_off.map(String) : [];
        const held = whys(d.held);
        const refused = whys(d.refused);
        setBatch({ handed, held, refused });
        if (typeof d.message === 'string') return d.message;
        const n = Array.isArray(d.handed_off) ? handed.length : emailIds.length;
        return `Handed ${n} of ${emailIds.length} emails to the sender. ${held.length} held, ${refused.length} refused.`;
      },
      false,
    );

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!sel || busy || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'j' || e.key === 'ArrowDown') pick(at + 1);
    else if (k === 'k' || e.key === 'ArrowUp') pick(at - 1);
    else if (k === 'c') copyOpen(sel);
    else if (k === 's') markSent(sel);
    else if (k === 'e') edit(sel);
    else if (k === 'x' && sel.draft_id) setMode('skip');
    else if (e.key === 'Escape') setMode('view');
    else return;
    e.preventDefault();
  };

  const missingRoute =
    res.error instanceof ApiError && (res.error.status === 404 || res.error.status === 403);
  const size = res.data?.size ?? 0;
  return (
    <section className="today" aria-labelledby={head}>
      <header className="today-head">
        <div>
          <h2 id={head}>Today</h2>
          <span className="muted small">
            {res.data ? (
              actions.length > 0 ? (
                `${actions.length} of ${size} · ranked by ${res.data.ranked_by === 'score' ? 'lead score' : 'age, oldest first'}`
              ) : (
                'Nothing to do on Today. New actions arrive after the morning run.'
              )
            ) : missingRoute ? (
              'Today is not on this FlowWeb yet.'
            ) : (
              <AsOf res={res} />
            )}
          </span>
        </div>
        {emailIds.length > 0 && (
          <Button variant="primary" onClick={approveBatch} disabledReason={busy ? 'Working.' : null}>
            Approve email batch ({emailIds.length})
          </Button>
        )}
      </header>
      {emailTo.length > 0 && (
        <p className="muted small">Approve email batch hands these to the sender: {emailTo.join(', ')}</p>
      )}
      {batch && (batch.held.length > 0 || batch.refused.length > 0) && (
        <section className="today-batch small" aria-label="Batch result">
          {(
            [
              ['Held for a later batch', batch.held],
              ['Refused', batch.refused],
            ] as const
          ).map(
            ([label, list]) =>
              list.length > 0 && (
                <div key={label}>
                  <strong>{label}</strong>
                  <ul>
                    {list.map((x) => (
                      <li key={x.id}>
                        {nameOf(x.id)}: {x.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              ),
          )}
        </section>
      )}
      <p className={`today-note${note ? ` is-${note.tone}` : ''}`} aria-live="polite">
        {note?.text}
      </p>
      {actions.length > 0 && (
        <div className="today-body">
          <div
            ref={listRef}
            className="today-list"
            role="listbox"
            aria-label="Today's actions"
            aria-keyshortcuts="J K C S E X"
            tabIndex={0}
            aria-activedescendant={sel ? `${listId}-${at}` : undefined}
            onKeyDown={onKey}
          >
            {actions.map((a, i) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox takes the keys for its options
              <div
                key={a.id}
                id={`${listId}-${i}`}
                role="option"
                tabIndex={-1}
                aria-selected={i === at}
                className={`today-item${i === at ? ' is-on' : ''}`}
                onClick={() => {
                  pick(i);
                  listRef.current?.focus();
                }}
              >
                <span className="today-item-n">{i + 1}</span>
                <span className="today-item-who">{a.name}</span>
                <span className="today-item-kind">{KIND[a.kind]}</span>
                <span className="today-item-facts">{facts(a)}</span>
              </div>
            ))}
          </div>
          {sel && (
            <section className="today-detail" aria-label="Today action">
              <div className="today-detail-head">
                <strong>{sel.name}</strong>
                <span className="muted small">{facts(sel)}</span>
                {sel.source_url && (
                  <a href={sel.source_url} target="_blank" rel="noreferrer" className="small">
                    Source
                  </a>
                )}
              </div>
              {mode === 'edit' ? (
                <textarea
                  className="today-edit"
                  aria-label="Draft text"
                  value={draftText}
                  onChange={(e) => setDraftText(e.target.value)}
                  rows={8}
                />
              ) : (
                sel.body && <p className="today-text">{sel.body}</p>
              )}
              <div className="today-actions">
                {sel.kind === 'approve_lead' ? (
                  <Button variant="primary" onClick={() => approveLead(sel)}>
                    Approve lead
                  </Button>
                ) : mode === 'edit' ? (
                  <>
                    <Button variant="primary" onClick={() => save(sel)}>
                      Save
                    </Button>
                    <Button onClick={() => setMode('view')}>Cancel</Button>
                  </>
                ) : (
                  <>
                    {sel.open_url && (
                      <Button variant="primary" shortcut="C" onClick={() => copyOpen(sel)}>
                        {sel.body ? 'Copy and open' : 'Open'}
                      </Button>
                    )}
                    {sel.draft_id && (
                      <>
                        <Button shortcut="S" onClick={() => markSent(sel)}>
                          Mark sent
                        </Button>
                        <Button shortcut="E" onClick={() => edit(sel)}>
                          Edit
                        </Button>
                        <Button
                          shortcut="X"
                          variant="quiet"
                          onClick={() => setMode(mode === 'skip' ? 'view' : 'skip')}
                        >
                          Skip
                        </Button>
                      </>
                    )}
                  </>
                )}
              </div>
              {mode === 'skip' && (
                <fieldset className="today-skips">
                  <legend className="small muted">Why skip it?</legend>
                  {SKIPS.map(([reason, label]) => (
                    <button
                      key={reason}
                      type="button"
                      className="today-skip"
                      onClick={() => skip(sel, reason, label)}
                    >
                      {label}
                    </button>
                  ))}
                </fieldset>
              )}
            </section>
          )}
        </div>
      )}
    </section>
  );
}

/** A route this fwd does not have yet answers 404: say so politely instead of showing the raw error. */
function notYet(what: string) {
  return (e: unknown): never => {
    if (e instanceof ApiError && e.status === 404)
      throw new Error(`${what} is not on this FlowWeb yet. Send these by hand for now.`);
    throw e;
  };
}
