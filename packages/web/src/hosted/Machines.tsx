import { type ReactNode, useState } from 'react';
import { api } from '../api/client';
import { useResource } from '../api/resource';
import { Copy, ResourceView } from '../ui-kit/honest';
import { StatusLabel, type StatusSpec } from '../ui-kit/status';
import { age, useNow } from '../ui-kit/time';

/** Machines older than this without a push are shown as not syncing. */
const QUIET_AFTER_MS = 5 * 60_000;

/** Hosted mode: which machines feed this mirror, and how to add one. */
export function MachinesPanel() {
  const live = useResource('hosted-machines', api.machines);
  // The machine list comes from this site, not from fwd, so a missing sync must not mark it stale.
  const res = live.data && !live.error ? { ...live, honesty: 'current' as const } : live;
  const now = useNow(15_000);
  const [label, setLabel] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.addMachine(label.trim() || 'My Mac');
      setToken(r.token);
      setLabel('');
      res.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const command = token
    ? `FW_RELAY_SITE=${location.origin} FW_RELAY_TOKEN=${token} node hosted/relay/fw-relay.mjs`
    : '';

  return (
    <section className="panel" aria-labelledby="mach-h">
      <h2 id="mach-h">Machines</h2>
      <p className="small muted">
        This site is a read-only mirror. FlowWeb itself runs on your machine; a small relay there pushes what
        you see here. Nothing on your machine is opened to the internet.
      </p>
      <ResourceView res={res} what="machine list">
        {(d) =>
          d.machines.length === 0 ? (
            <p>No machine has been added yet.</p>
          ) : (
            <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
              {d.machines.map((m) => {
                const quiet = !m.last_seen_at || now - new Date(m.last_seen_at).getTime() > QUIET_AFTER_MS;
                return (
                  <li key={m.id} className="row" style={{ justifyContent: 'space-between' }}>
                    <span>
                      <strong>{m.report.label ?? m.label}</strong>{' '}
                      {m.revoked_at ? (
                        <span className="status status-neutral">Revoked</span>
                      ) : quiet ? (
                        <span className="status status-warn">
                          {m.last_seen_at ? `Last synced ${age(m.last_seen_at, now)}` : 'Never synced'}
                        </span>
                      ) : (
                        <span className="status status-ok">Synced {age(m.last_seen_at, now)}</span>
                      )}
                      {m.report.fwd_version && (
                        <span className="small muted"> · fwd {m.report.fwd_version}</span>
                      )}
                    </span>
                    {!m.revoked_at && (
                      <button
                        type="button"
                        className="btn btn-quiet"
                        onClick={async () => {
                          await api.revokeMachine(m.id).catch(() => undefined);
                          res.reload();
                        }}
                      >
                        Revoke
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )
        }
      </ResourceView>

      {token ? (
        <div className="stack">
          <p className="callout callout-warn">
            Copy this now; it is shown once. In the FlowWeb repo on your machine, with fwd running, run:
          </p>
          <pre className="output">{command}</pre>
          <div className="row">
            <Copy text={command} label="relay command" />
            <button type="button" className="btn btn-quiet" onClick={() => setToken(null)}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="row">
          <label>
            <span className="small muted">Name </span>
            <input
              type="text"
              value={label}
              placeholder="My Mac"
              onChange={(e) => setLabel(e.target.value)}
              maxLength={80}
            />
          </label>
          <button type="button" className="btn" onClick={add} disabled={busy}>
            Add a machine
          </button>
        </div>
      )}
      {error && <p className="callout callout-warn">{error}</p>}
    </section>
  );
}

/** A command to run on the Mac, with a copy button. */
function Cmd({ text }: { text: string }) {
  return (
    <span className="cmd">
      <code>{text}</code>
      <Copy text={text} label="command" />
    </span>
  );
}

type AccountKey = 'claude_signin_token' | 'claude_api_key' | 'codex_signin' | 'codex_api_key';

const ACCOUNTS: { key: AccountKey; title: string; lane: string; steps: ReactNode[] }[] = [
  {
    key: 'claude_signin_token',
    title: 'Claude Pro or Max plan',
    lane: 'Claude runs use your plan instead of an API key.',
    steps: [
      <>
        On your Mac, run this and sign in with your Claude account in the browser window it opens. It prints a
        long-lived token.
        <Cmd text="claude setup-token" />
      </>,
      <>
        Store the token in your keychain. Paste it when asked.
        <Cmd text="security add-generic-password -U -s flowweb -a crd_claude0002 -w" />
      </>,
      <>
        Start fwd with the plan turned on:
        <Cmd text="FW_CLAUDE_AUTH=signin fwd" />
      </>,
    ],
  },
  {
    key: 'claude_api_key',
    title: 'Anthropic API key',
    lane: 'The default for Claude runs.',
    steps: [
      <>
        Create a key at <a href="https://console.anthropic.com/settings/keys">console.anthropic.com</a>.
      </>,
      <>
        Store it in your keychain. Paste it when asked.
        <Cmd text="security add-generic-password -U -s flowweb -a crd_claude0001 -w" />
      </>,
      <>Start fwd as usual. Leave FW_CLAUDE_AUTH unset.</>,
    ],
  },
  {
    key: 'codex_signin',
    title: 'ChatGPT plan (Codex)',
    lane: 'Codex runs use your ChatGPT plan instead of an API key.',
    steps: [
      <>
        Install the Codex CLI, run this and sign in with ChatGPT in the browser.
        <Cmd text="codex login" />
      </>,
      <>
        Check it worked:
        <Cmd text="codex login status" />
      </>,
      <>
        Start fwd with the plan turned on:
        <Cmd text="FW_CODEX_AUTH=signin fwd" />
      </>,
    ],
  },
  {
    key: 'codex_api_key',
    title: 'OpenAI API key',
    lane: 'The default for Codex runs.',
    steps: [
      <>
        Create a key at <a href="https://platform.openai.com/api-keys">platform.openai.com</a>.
      </>,
      <>
        Store it in your keychain. Paste it when asked.
        <Cmd text="security add-generic-password -U -s flowweb -a crd_codex0001 -w" />
      </>,
      <>Start fwd as usual. Leave FW_CODEX_AUTH unset.</>,
    ],
  },
];

/** Hosted mode: how to sign in each account on the Mac, and which ones the Mac reports as set up. */
export function AccountsPanel() {
  const res = useResource('hosted-machines', api.machines);
  const now = useNow(60_000);
  const reporting = (res.data?.machines ?? [])
    .filter((m) => !m.revoked_at && m.report.accounts)
    .sort((a, b) => (b.last_seen_at ?? '').localeCompare(a.last_seen_at ?? ''));
  const m = reporting[0];
  const acc = m?.report.accounts;
  return (
    <section className="panel" aria-labelledby="acct-h">
      <h2 id="acct-h">Accounts and API keys</h2>
      <p className="small muted">
        Agents run on your Mac, so you sign in there, not on this site. Tokens and keys stay in your Mac's
        keychain. The relay only reports whether each one is set up, never the secret itself. To use both
        plans, start fwd with both settings: <code>FW_CLAUDE_AUTH=signin FW_CODEX_AUTH=signin fwd</code>.
      </p>
      <p className="small">
        {acc && m ? (
          <>
            Status from <strong>{m.report.label ?? m.label}</strong>, checked {age(acc.checked_at, now)}.
          </>
        ) : (
          <span className="muted">Status appears here once your Mac syncs with an up-to-date relay.</span>
        )}
      </p>
      <ol className="account-list">
        {ACCOUNTS.map((a) => {
          const v = acc ? acc[a.key] : undefined;
          const spec: StatusSpec =
            v === true
              ? { word: 'Set up', tone: 'ok', icon: 'pass' }
              : v === false
                ? { word: 'Not set up', tone: 'neutral', icon: 'open' }
                : {
                    word: v === null ? "Mac can't tell" : 'Not reported yet',
                    tone: 'unknown',
                    icon: 'unknown',
                  };
          return (
            <li key={a.key} className="account">
              <div className="account-head">
                <h3>{a.title}</h3>
                <StatusLabel spec={spec} />
              </div>
              <p className="small muted">{a.lane}</p>
              <ol className="account-steps">
                {a.steps.map((step, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed, ordered steps
                  <li key={i}>{step}</li>
                ))}
              </ol>
            </li>
          );
        })}
      </ol>
      <p className="small muted">
        Claude and ChatGPT accounts cannot sign in to this website. You sign in here with your FlowWeb login.
      </p>
    </section>
  );
}
