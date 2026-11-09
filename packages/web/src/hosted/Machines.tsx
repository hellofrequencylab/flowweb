import { useState } from 'react';
import { api } from '../api/client';
import { useResource } from '../api/resource';
import { Copy, ResourceView } from '../ui-kit/honest';
import { age, useNow } from '../ui-kit/time';

/** Machines older than this without a push are shown as not syncing. */
const QUIET_AFTER_MS = 5 * 60_000;

/** Hosted mode: which machines feed this mirror, and how to add one. */
export function MachinesPanel() {
  const res = useResource('hosted-machines', api.machines);
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

/** Hosted mode: an honest account of which sign-ins can drive FlowWeb, and where they live. */
export function AccountsPanel() {
  return (
    <section className="panel" aria-labelledby="acct-h">
      <h2 id="acct-h">Accounts and API keys</h2>
      <p className="small muted">
        Agents run on your machine, so your accounts and keys stay there. This site never holds them.
      </p>
      <dl className="facts">
        <dt>Anthropic API key</dt>
        <dd>
          Used for agent runs today. Store it in your Mac's Keychain, where FlowWeb reads it:{' '}
          <code>security add-generic-password -U -s flowweb -a crd_claude0001 -w</code> (it prompts for the
          key).
        </dd>
        <dt>Claude and Claude Code account</dt>
        <dd>
          Sign in once with <code>claude</code> on your Mac. FlowWeb's policy runs agents on API keys only for
          now; using your subscription instead is an owner decision, not a setting here. Claude accounts
          cannot sign in to other websites, including this one.
        </dd>
        <dt>ChatGPT Business and OpenAI API key</dt>
        <dd>
          Sign in with <code>codex login</code> on your Mac, or set an OpenAI API key there. FlowWeb does not
          have an adapter for this vendor yet, so neither is used for runs today. ChatGPT accounts cannot sign
          in to other websites either.
        </dd>
      </dl>
    </section>
  );
}
