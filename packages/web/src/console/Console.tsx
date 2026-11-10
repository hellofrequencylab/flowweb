import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { ApiError, api, ownerWrite } from '../api/client';
import { looksLikeSecret } from '../setup/assistant';
import { useRouter } from '../shell/router';
import { Button } from '../ui-kit/Button';
import { Icon } from '../ui-kit/Icon';
import {
  flowOf,
  loadTurns,
  type Proposal,
  pageName,
  readPage,
  SECRET_REFUSAL,
  saveTurns,
  starters,
  type Turn,
} from './console';

const NOTE: Record<string, string> = {
  done: 'Done.',
  queued: 'Sent to your Mac. It applies when FlowWeb there picks it up, usually within a minute.',
  skipped: 'Left as it is.',
};

/** Why the console could not answer, in words. */
function troubleOf(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'not_configured') return 'The console has no AI on this site yet.';
    if (e.status === 501) return 'The AI console answers on flowweb.app.';
    return e.message;
  }
  return 'The console could not be reached. Try again in a moment.';
}

/** One proposed change: what will change, and the two buttons. Nothing is written until Make this change. */
function ProposalCard({
  p,
  canChange,
  onMake,
  onSkip,
}: {
  p: Proposal;
  canChange: boolean;
  onMake: () => void;
  onSkip: () => void;
}) {
  return (
    <fieldset className="console-proposal">
      <legend className="console-proposal-what">{p.summary}</legend>
      {p.state === 'open' || p.state === 'busy' ? (
        canChange && (
          <div className="draft-actions">
            <Button className="btn-small" variant="primary" onClick={onMake} disabled={p.state === 'busy'}>
              Make this change
            </Button>
            <Button className="btn-small" variant="quiet" onClick={onSkip} disabled={p.state === 'busy'}>
              Not now
            </Button>
          </div>
        )
      ) : (
        <p className={p.state === 'failed' ? 'console-note console-failed' : 'console-note'} role="status">
          {p.state === 'failed' ? p.note : NOTE[p.state]}
        </p>
      )}
    </fieldset>
  );
}

/**
 * FW-C-092: the AI console, at the bottom right of every page. It knows the page and flow in view, answers
 * questions from what FlowWeb mirrored (including what the flow's review says is working), and proposes
 * changes. A change is made only when the person presses Make this change, through the same request the
 * page's own control sends.
 */
export function Console() {
  const { loc } = useRouter();
  const flow = flowOf(loc.path, loc.query);
  const name = pageName(loc.path);
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>(loadTurns);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [canChange, setCanChange] = useState(true);
  const fab = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLOListElement>(null);
  const panelId = useId();

  useEffect(() => saveTurns(turns), [turns]);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  const count = turns.length;
  useEffect(() => {
    const el = logRef.current;
    if (el && count) el.scrollTop = el.scrollHeight;
  }, [count]);

  const close = () => {
    setOpen(false);
    fab.current?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };

  const setProposal = (at: number, id: string, change: Partial<Proposal>) =>
    setTurns((ts) =>
      ts.map((t) =>
        t.at === at
          ? { ...t, proposals: t.proposals?.map((p) => (p.id === id ? { ...p, ...change } : p)) }
          : t,
      ),
    );

  const make = async (at: number, p: Proposal) => {
    setProposal(at, p.id, { state: 'busy' });
    try {
      await ownerWrite<unknown>(p.method, p.path, p.method === 'POST' ? (p.body ?? {}) : undefined, () =>
        setProposal(at, p.id, { state: 'queued' }),
      );
      setProposal(at, p.id, { state: 'done' });
    } catch (e) {
      setProposal(at, p.id, {
        state: 'failed',
        note: e instanceof Error ? e.message : 'That change did not go through.',
      });
    }
  };

  const ask = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    if (looksLikeSecret(q)) {
      // Refused before it is shown, stored or sent.
      setQuestion('');
      setWarning(SECRET_REFUSAL);
      return;
    }
    setWarning(null);
    setQuestion('');
    const history = turns.slice(-8).map((t) => ({ who: t.who, text: t.text }));
    setTurns((ts) => [...ts, { at: Date.now() + ts.length, who: 'you', text: q }]);
    setBusy(true);
    let next: Omit<Turn, 'at'>;
    try {
      const page = readPage();
      const r = await api.askConsole({ question: q, page: { path: loc.path, name, ...page }, flow, history });
      setCanChange(r.can_change !== false);
      next = {
        who: 'ai',
        text: r.answer,
        proposals: (r.proposals ?? []).map((p) => ({ ...p, state: 'open' as const })),
      };
    } catch (e) {
      next = { who: 'ai', text: troubleOf(e), failed: true };
    }
    setTurns((ts) => [...ts, { ...next, at: Date.now() + ts.length }]);
    setBusy(false);
  };

  return (
    <div className="console-dock">
      {open && (
        <section
          id={panelId}
          className="console-panel"
          role="dialog"
          aria-modal="false"
          aria-label="AI console"
          onKeyDown={onKey}
        >
          <header className="console-head">
            <h2 className="console-title">AI console</h2>
            <Button className="btn-small" variant="quiet" onClick={close} aria-label="Close the AI console">
              <Icon name="x" size={14} />
            </Button>
          </header>
          <p className="console-where muted">
            Looking at {name}
            {flow ? (
              <>
                , flow <code>{flow}</code>
              </>
            ) : null}
          </p>
          {!canChange && (
            <p className="console-note muted">Your role can ask questions here, not change things.</p>
          )}
          {turns.length > 0 ? (
            <ol className="assist-log console-log" role="log" aria-label="Console conversation" ref={logRef}>
              {turns.map((t) =>
                t.who === 'you' ? (
                  <li key={t.at} className="assist-turn">
                    <p className="assist-ask">
                      <span className="assist-who">You</span> {t.text}
                    </p>
                  </li>
                ) : (
                  <li key={t.at} className="assist-turn">
                    <div className={t.failed ? 'assist-reply assist-failed' : 'assist-reply'}>
                      <span className="assist-who">AI</span>
                      <p className="console-answer">{t.text}</p>
                      {t.proposals?.map((p) => (
                        <ProposalCard
                          key={p.id}
                          p={p}
                          canChange={canChange}
                          onMake={() => void make(t.at, p)}
                          onSkip={() => setProposal(t.at, p.id, { state: 'skipped' })}
                        />
                      ))}
                    </div>
                  </li>
                ),
              )}
            </ol>
          ) : (
            <div className="draft-actions console-starters">
              {starters(flow).map((s) => (
                <Button key={s} className="btn-small" onClick={() => void ask(s)}>
                  {s}
                </Button>
              ))}
            </div>
          )}
          {busy && (
            <p className="muted console-note" role="status">
              Thinking.
            </p>
          )}
          {warning && (
            <p className="console-note console-failed" role="alert">
              {warning}
            </p>
          )}
          <form
            className="draft-ai-ask console-ask"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(question);
            }}
          >
            <input
              ref={input}
              type="text"
              aria-label="Ask the AI console"
              placeholder={
                flow ? 'Ask about this flow, or tell it what to change' : 'Ask anything about this page'
              }
              value={question}
              maxLength={2000}
              onChange={(e) => setQuestion(e.target.value)}
            />
            <Button type="submit" variant="primary" disabled={busy || !question.trim()}>
              Ask
            </Button>
          </form>
          <p className="muted console-hint">Changes happen only when you press Make this change.</p>
        </section>
      )}
      <button
        ref={fab}
        type="button"
        className="console-fab"
        aria-label="Open AI console"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Icon name="sparkles" size={20} />
      </button>
    </div>
  );
}
