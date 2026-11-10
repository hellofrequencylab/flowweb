import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useResource } from '../api/resource';
import { Link } from '../shell/router';
import { Button } from '../ui-kit/Button';
import { Copy } from '../ui-kit/honest';
import { Icon } from '../ui-kit/Icon';
import {
  builtInAnswer,
  INSTALL_STEPS,
  knownFrom,
  looksLikeSecret,
  PROVIDERS,
  type Provider,
  SECRET_REFUSAL,
  type Stage,
  stageOf,
  type TestKey,
} from './assistant';

/** One line of the conversation. A secret never becomes one: it is refused before this. */
type Turn = { at: number; who: 'you' | 'ai'; text: string };

const STORE = 'fw.setup-assistant.v1';

function load(): { turns: Turn[]; provider: Provider | null } {
  try {
    const v = JSON.parse(sessionStorage.getItem(STORE) ?? 'null');
    if (v && Array.isArray(v.turns)) return { turns: v.turns, provider: v.provider ?? null };
  } catch {
    /* no storage, or not ours */
  }
  return { turns: [], provider: null };
}

function save(turns: Turn[], provider: Provider | null) {
  try {
    sessionStorage.setItem(STORE, JSON.stringify({ turns, provider }));
  } catch {
    /* private window: the conversation lives only in this page */
  }
}

/** A command to run on the person's own machine, with a copy button. */
function Cmd({ text }: { text: string }) {
  return (
    <span className="cmd">
      <code>{text}</code>
      <Copy text={text} label="command" />
    </span>
  );
}

const ACCOUNT_NAME: Record<TestKey, string> = {
  claude_signin: 'Claude plan',
  claude_api_key: 'Anthropic API key',
  codex_signin: 'ChatGPT plan',
  codex_api_key: 'OpenAI API key',
};

/**
 * FW-C-085: a guided helper on Get started. It reads what the machine last reported, says the one next
 * thing to do, walks a new person through connecting their own AI account on their own machine, and
 * answers setup questions. It never takes a key: anything that looks like one is refused unsent.
 */
export function SetupAssistant({ hosted }: { hosted: boolean }) {
  const setup = useResource('setup', () => api.setup(), ['runs', 'cards', 'rows']);
  const machines = useResource(
    'hosted-machines',
    () => (hosted ? api.machines() : Promise.resolve({ data_as_of: '', machines: [] })),
    [],
  );
  const known = knownFrom(setup.data, hosted ? machines.data : null, hosted);
  const stage: Stage = stageOf(known);

  const [state, setState] = useState(load);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const logRef = useRef<HTMLOListElement>(null);

  useEffect(() => save(state.turns, state.provider), [state]);
  const turnCount = state.turns.length;
  useEffect(() => {
    const el = logRef.current;
    if (el && turnCount) el.scrollTop = el.scrollHeight;
  }, [turnCount]);

  const choose = (provider: Provider | null) => setState((s) => ({ ...s, provider }));
  const add = (t: Omit<Turn, 'at'>) =>
    setState((s) => ({ ...s, turns: [...s.turns, { ...t, at: Date.now() + s.turns.length }] }));

  const ask = async () => {
    const q = question.trim();
    if (!q || busy) return;
    if (looksLikeSecret(q)) {
      // Refused before it is shown, stored or sent.
      setQuestion('');
      setWarning(SECRET_REFUSAL);
      return;
    }
    setWarning(null);
    setQuestion('');
    add({ who: 'you', text: q });
    setBusy(true);
    let answer = '';
    if (hosted) {
      try {
        answer = (await api.askSetupAssistant(q, stage)).answer?.trim() ?? '';
      } catch {
        answer = '';
      }
    }
    add({ who: 'ai', text: answer || builtInAnswer(q) });
    setBusy(false);
  };

  const picked = PROVIDERS.find((p) => p.id === state.provider) ?? null;
  const failed = (Object.keys(known.accounts) as TestKey[]).filter((k) => known.accounts[k] === false);
  const working = (Object.keys(known.accounts) as TestKey[]).filter((k) => known.accounts[k] === true);

  return (
    <section className="panel setup-assistant" aria-labelledby="sa-h">
      <h2 id="sa-h" className="row">
        <Icon name="sparkles" size={16} /> Setup assistant
      </h2>

      <div className="assist-reply setup-guide" role="status" aria-label="What to do next">
        <span className="assist-who">Assistant</span>
        {stage === 'machine' && (
          <>
            <p>
              First, FlowWeb needs a computer to run on: a Mac or Linux machine that stays on. Your AI
              accounts connect there, so your keys never leave it. In a terminal on that machine, run:
            </p>
            {INSTALL_STEPS.map((c) => (
              <Cmd key={c} text={c} />
            ))}
            {hosted ? (
              <p>
                Then open <Link to="/settings">Settings</Link>, press Add a machine, and run the command it
                shows in the FlowWeb folder. This page moves on by itself once your machine reports in.
              </p>
            ) : (
              <p>This page moves on by itself once fwd answers.</p>
            )}
          </>
        )}

        {stage === 'ai' && !picked && (
          <>
            <p>Your machine is connected. Next, connect an AI account. Which one do you have?</p>
            <fieldset className="draft-actions setup-pick">
              <legend className="visually-hidden">Your AI account</legend>
              {PROVIDERS.map((p) => (
                <Button key={p.id} className="btn-small" onClick={() => choose(p.id)}>
                  {p.label}
                </Button>
              ))}
            </fieldset>
            <p className="small muted">
              Not sure? Use a plan you already pay for. With none, Claude Pro is a good start.
            </p>
          </>
        )}

        {stage === 'ai' && picked && (
          <>
            <p>
              <strong>{picked.label}.</strong> {picked.blurb}
            </p>
            <p>On your machine, in the FlowWeb folder, run:</p>
            <Cmd text={picked.command} />
            <p>
              It tests the account with one tiny real call. This page shows the result once your machine
              reports it, usually within a minute or two. Paste keys only into your terminal, never into this
              page.
            </p>
            <Button className="btn-small" variant="quiet" onClick={() => choose(null)}>
              Pick a different account
            </Button>
          </>
        )}

        {stage === 'fix_ai' && (
          <>
            <p>
              Your machine tested your AI account and it did not work yet:{' '}
              {failed.map((k) => ACCOUNT_NAME[k]).join(', ')}.
            </p>
            {failed.map((k) =>
              known.fixes[k] ? (
                <p key={k} className="small">
                  {ACCOUNT_NAME[k]}: {known.fixes[k]}
                </p>
              ) : null,
            )}
            <p>Fix it on your machine, then test again:</p>
            <Cmd text="pnpm fw accounts check" />
          </>
        )}

        {(stage === 'next_steps' || stage === 'done') && (
          <p>
            Your AI works: {working.map((k) => ACCOUNT_NAME[k]).join(', ') || 'signed in'}.{' '}
            {stage === 'done'
              ? 'Everything required is set up.'
              : `Next: ${known.remaining[0]?.title ?? 'the steps below'}.`}
          </p>
        )}
        {stage === 'next_steps' &&
          known.remaining[0]?.fix &&
          (/^(pnpm|FW_[A-Z_]+=)/.test(known.remaining[0].fix) ? (
            <Cmd text={known.remaining[0].fix} />
          ) : (
            <p className="small">{known.remaining[0].fix}</p>
          ))}
      </div>

      {state.turns.length > 0 && (
        <ol className="assist-log" role="log" aria-label="Setup conversation" ref={logRef}>
          {state.turns.map((t) =>
            t.who === 'you' ? (
              <li key={t.at} className="assist-turn">
                <p className="assist-ask">
                  <span className="assist-who">You</span> {t.text}
                </p>
              </li>
            ) : (
              <li key={t.at} className="assist-turn">
                <p className="assist-reply">
                  <span className="assist-who">Assistant</span> {t.text}
                </p>
              </li>
            ),
          )}
        </ol>
      )}

      {warning && (
        <p className="callout callout-warn" role="alert">
          {warning}
        </p>
      )}
      <div className="draft-ai-ask">
        <input
          type="text"
          aria-label="Ask the setup assistant"
          placeholder="Ask anything about setup, e.g. which AI should I use?"
          value={question}
          maxLength={1000}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void ask();
          }}
        />
        <Button
          onClick={() => void ask()}
          disabledReason={busy ? 'Thinking.' : question.trim() ? null : 'Type a question first.'}
        >
          Ask
        </Button>
      </div>
      {busy && (
        <p className="muted" role="status">
          Thinking.
        </p>
      )}
      <p className="small muted">
        Never paste a key or password here. Keys go into your own computer's keychain when the command asks.
        This conversation stays in this browser tab.
      </p>
      {state.turns.length > 0 && (
        <Button
          className="btn-small"
          variant="quiet"
          onClick={() => setState({ turns: [], provider: state.provider })}
        >
          Clear conversation
        </Button>
      )}
    </section>
  );
}
