import { type FormEvent, useState } from 'react';
import { api, type StartAnswer, type StartNode } from '../api/client';
import { Button } from '../ui-kit/Button';
import { PageHead } from '../ui-kit/page';
import './start.css';

const ASK = 'What should your business do?';

/**
 * FW-C-124: the first run. One box and one button. The sentence becomes a node: its name, the goal in the
 * Owner's words, and the steps its flow takes, each opening to what it needs. A second sentence grows the node.
 * Settings show up only on a step that needs one. The node becomes a draft flow (off, on Draft), or a build
 * request when no flow does this yet. Nothing sends, posts or spends from here.
 */
export function OnePrompt() {
  const [prompt, setPrompt] = useState('');
  const [answer, setAnswer] = useState<StartAnswer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask(text: string, previous?: StartNode) {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    try {
      const prev = previous ? { name: previous.name, goal: previous.goal, base: previous.base } : undefined;
      setAnswer(await api.startNode(t, prev));
      setPrompt('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not make that just now.');
    } finally {
      setBusy(false);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void ask(prompt);
  };

  return (
    <div className="one-prompt">
      <PageHead
        title="Start with one sentence"
        lede="Say what you want done. It becomes something you can shape, then make."
      />
      {!answer && (
        <form className="one-prompt-form" onSubmit={submit}>
          <label className="field">
            <span className="field-label">{ASK}</span>
            <textarea
              className="field-big"
              rows={3}
              maxLength={2000}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Find yoga teachers in Austin who would host a class"
            />
          </label>
          <Button type="submit" variant="primary" disabled={busy || !prompt.trim()}>
            {busy ? 'Making it' : 'Make it'}
          </Button>
        </form>
      )}
      {error && (
        <p className="one-prompt-error" role="alert">
          {error}
        </p>
      )}
      {answer && (
        <NodeCard
          key={`${answer.node.name}|${answer.node.goal}`}
          answer={answer}
          busy={busy}
          onGrow={(t) => ask(t, answer.node)}
          onReset={() => {
            setAnswer(null);
            setError(null);
          }}
        />
      )}
    </div>
  );
}

function NodeCard({
  answer: { node, can_make },
  busy,
  onGrow,
  onReset,
}: {
  answer: StartAnswer;
  busy: boolean;
  onGrow: (text: string) => Promise<void>;
  onReset: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [more, setMore] = useState('');
  const [state, setState] = useState<'idle' | 'working' | 'queued'>('idle');
  const [made, setMade] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function make() {
    if (!node.copy) return;
    setState('working');
    setError(null);
    try {
      const r = await api.makeNodeFlow(node.copy, () => setState('queued'));
      setMade(r?.key ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not make the flow.');
    } finally {
      setState('idle');
    }
  }

  async function build() {
    if (!node.build_request) return;
    setState('working');
    setError(null);
    try {
      await api.addBuildRequest(node.build_request);
      setAsked(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the request.');
    } finally {
      setState('idle');
    }
  }

  const grow = (e: FormEvent) => {
    e.preventDefault();
    void onGrow(more);
  };

  return (
    <section className="node" aria-label={node.name}>
      <header className="node-head">
        <h2>{node.name}</h2>
        <span className="node-dial">{made ? 'Draft flow, off' : 'Draft'}</span>
      </header>
      <p className="node-goal">{node.goal}</p>
      {node.why && <p className="node-why">{node.why}</p>}

      {node.steps.length > 0 && (
        <ol className="node-steps">
          {node.steps.map((s) => {
            const isOpen = open === s.id;
            return (
              <li key={s.id} className={isOpen ? 'is-open' : undefined}>
                <button
                  type="button"
                  className="node-step"
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : s.id)}
                >
                  <span className="node-step-label">{s.label}</span>
                  {s.needs && <span className="node-step-needs">Needs you</span>}
                </button>
                {isOpen && (
                  <div className="node-step-body">
                    <p>{s.detail}</p>
                    {s.needs && <p className="node-step-need">{s.needs.label}</p>}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <div className="node-actions">
        {made ? (
          <p className="node-done">
            Made it. It is a draft flow and stays off until you turn it on.{' '}
            <a href={`/flows/${made}`}>Open it</a>
          </p>
        ) : asked ? (
          <p className="node-done">Asked. The CTO has your build request.</p>
        ) : node.copy ? (
          <Button variant="primary" onClick={make} disabled={state !== 'idle'}>
            Make it a draft flow
          </Button>
        ) : node.build_request ? (
          <Button variant="primary" onClick={build} disabled={state !== 'idle'}>
            Ask the CTO to build it
          </Button>
        ) : !can_make ? (
          <p className="node-why">Only an owner or admin can make this.</p>
        ) : null}
        {state === 'queued' && <p className="node-why">Waiting for your Mac to make it.</p>}
        {error && (
          <p className="one-prompt-error" role="alert">
            {error}
          </p>
        )}
      </div>

      <form className="node-grow" onSubmit={grow}>
        <label className="field">
          <span className="field-label">Add to it</span>
          <input type="text" maxLength={2000} value={more} onChange={(e) => setMore(e.target.value)} />
        </label>
        <Button type="submit" disabled={busy || !more.trim()}>
          Add
        </Button>
      </form>
      <Button variant="quiet" onClick={onReset}>
        Start over
      </Button>
    </section>
  );
}
