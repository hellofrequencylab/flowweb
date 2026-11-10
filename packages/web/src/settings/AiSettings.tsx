// FW-C-086: which AI account each flow uses, from Settings, for every account holder who may change it.
//
// Before this the choice was an env var given when fwd started (FW_CLAUDE_AUTH, FW_CODEX_AUTH) or a line
// in the flow's config.json, both on the Owner's Mac. Here a person picks one of the four accounts per flow.
// On the live site the change is queued and the relay applies it on the machine (kind flow.ai); on the Mac
// fwd applies it at once. Only the choice moves: keys stay in the machine's keychain.
import { useState } from 'react';
import { api } from '../api/client';
import { useResource } from '../api/resource';
import type { FlowAiAccount, SupervisorFlow } from '../api/types';
import type { WAccountTest } from '../api/wire';
import { ResourceView } from '../ui-kit/honest';

type TestKey = keyof WAccountTest['accounts'];

export const AI_CHOICES: {
  account: FlowAiAccount;
  label: string;
  adapter: 'claude' | 'codex';
  auth: 'signin' | 'api_key';
  test: TestKey;
}[] = [
  { account: 'claude_plan', label: 'Claude plan', adapter: 'claude', auth: 'signin', test: 'claude_signin' },
  {
    account: 'anthropic_key',
    label: 'Anthropic API key',
    adapter: 'claude',
    auth: 'api_key',
    test: 'claude_api_key',
  },
  { account: 'chatgpt_plan', label: 'ChatGPT plan', adapter: 'codex', auth: 'signin', test: 'codex_signin' },
  {
    account: 'openai_key',
    label: 'OpenAI API key',
    adapter: 'codex',
    auth: 'api_key',
    test: 'codex_api_key',
  },
];

/** The account a flow's ai names. An engine with no lane is the API key, as fwd treats it. */
export function accountOf(ai: SupervisorFlow['ai']): FlowAiAccount | null {
  if (!ai) return null;
  const auth = ai.auth ?? 'api_key';
  return AI_CHOICES.find((c) => c.adapter === ai.adapter && c.auth === auth)?.account ?? null;
}

const testWord = (t: { set_up: boolean | null; ok: boolean | null } | undefined) =>
  !t || t.set_up === false
    ? 'not set up'
    : t.ok === true
      ? 'works'
      : t.ok === false
        ? 'test failed'
        : 'not tested';

function FlowAiRow({
  flow,
  tests,
  canChange,
  reload,
}: {
  flow: SupervisorFlow;
  tests: WAccountTest['accounts'];
  canChange: boolean;
  reload: () => void;
}) {
  const current = accountOf(flow.ai ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const pick = async (account: FlowAiAccount) => {
    if (!canChange || account === current || busy) return;
    const label = AI_CHOICES.find((c) => c.account === account)?.label ?? account;
    setBusy('Saving.');
    setNote(null);
    let queued = false;
    try {
      await api.setFlowAi(flow.key, account, () => {
        queued = true;
        setBusy('Saving. Waiting for your machine to apply it.');
      });
      setNote({ ok: true, text: `${flow.name} now uses your ${label}.` });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
      reload();
      if (queued) window.setTimeout(reload, 8000);
    }
  };

  const why = !canChange ? 'Only an owner or admin can change this.' : busy;
  return (
    <fieldset className="setting setting-choice">
      <legend className="visually-hidden">AI account for {flow.name}</legend>
      <span className="setting-text" aria-hidden="true">
        <span className="setting-label">{flow.name}</span>
        <span className="setting-desc">
          {current
            ? flow.ai?.chosen
              ? 'Chosen here.'
              : "From the flow's setup."
            : 'Not chosen yet. FlowWeb picks one from what works.'}
        </span>
      </span>
      <span className="segmented">
        {AI_CHOICES.map((c) => (
          <label key={c.account} title={`Your ${c.label}: ${testWord(tests[c.test])}`}>
            <input
              type="radio"
              name={`ai-${flow.key}`}
              checked={current === c.account}
              disabled={Boolean(why)}
              onChange={() => void pick(c.account)}
            />
            {c.label}
          </label>
        ))}
      </span>
      {busy && (
        <span className="setting-desc" role="status">
          {busy}
        </span>
      )}
      {note && (
        <span className={`setting-desc ${note.ok ? '' : 'callout-warn'}`} role="status">
          {note.text}
        </span>
      )}
      {current && tests[AI_CHOICES.find((c) => c.account === current)!.test]?.ok === false && (
        <span className="setting-desc">
          That account failed its last test. See <a href="/setup">Get started</a> for the fix.
        </span>
      )}
    </fieldset>
  );
}

/**
 * Settings, "AI for each flow". On the live site each choice shows what the machine's last
 * `fw accounts check` said about that account. canChange is false for helpers and viewers.
 */
export function AiSettings({ hosted, canChange = true }: { hosted: boolean; canChange?: boolean }) {
  const res = useResource('supervisor', () => api.supervisor(), ['runs', 'cards']);
  const machines = useResource(
    'hosted-machines',
    () => (hosted ? api.machines() : Promise.resolve({ data_as_of: '', machines: [] })),
    [],
  );
  const tests: WAccountTest['accounts'] =
    (machines.data?.machines ?? [])
      .filter((m) => !m.revoked_at && m.report?.account_test)
      .sort((a, b) => (b.last_seen_at ?? '').localeCompare(a.last_seen_at ?? ''))[0]?.report.account_test
      ?.accounts ?? {};
  return (
    <section className="settings-group" aria-labelledby="ai-h">
      <h2 id="ai-h">
        AI for each flow
        <span className="setting-desc">
          Which of your AI accounts each flow uses. Keys stay on your machine; this only picks one. Connect an
          account on <a href="/setup">Get started</a>.
        </span>
      </h2>
      <div className="settings-body">
        <div className="panel settings-panel">
          <ResourceView res={res} what="flows">
            {(d) =>
              d.flows.length === 0 ? (
                <p>No flows yet.</p>
              ) : (
                d.flows.map((f) => (
                  <FlowAiRow key={f.key} flow={f} tests={tests} canChange={canChange} reload={res.reload} />
                ))
              )
            }
          </ResourceView>
        </div>
      </div>
    </section>
  );
}
