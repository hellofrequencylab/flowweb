import { useState } from 'react';
import { api } from '../api/client';
import { useResource } from '../api/resource';
import { HOSTED, signedInEmail } from '../hosted/auth';
import { AccountsPanel, MachinesPanel } from '../hosted/Machines';
import { KillControl } from '../shell/KillSwitch';
import { type Prefs, usePrefs } from '../shell/prefs';
import { Copy, ResourceView } from '../ui-kit/honest';
import { Icon } from '../ui-kit/Icon';
import { shortHash, when } from '../ui-kit/time';

function Toggle({
  k,
  label,
  hint,
  disabled,
}: {
  k: keyof Prefs;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  const { prefs, set } = usePrefs();
  return (
    <label className="row" style={{ minHeight: 'var(--fw-target)' }}>
      <input
        type="checkbox"
        checked={Boolean(prefs[k])}
        onChange={(e) => set({ [k]: e.target.checked } as Partial<Prefs>)}
        disabled={disabled}
        style={{ width: '20px', height: '20px' }}
      />
      <span>
        {label}
        {hint && <span className="small muted"> · {hint}</span>}
      </span>
    </label>
  );
}

function Choice<K extends keyof Prefs>({
  k,
  label,
  options,
}: {
  k: K;
  label: string;
  options: { v: Prefs[K]; label: string }[];
}) {
  const { prefs, set } = usePrefs();
  return (
    <fieldset style={{ border: 0, padding: 0, margin: '0 0 var(--fw-space-3)' }}>
      <legend className="small muted">{label}</legend>
      <div className="row">
        {options.map((o) => (
          <label
            key={String(o.v)}
            className="row"
            style={{ minHeight: 'var(--fw-target)', gap: 'var(--fw-space-1)' }}
          >
            <input
              type="radio"
              name={String(k)}
              checked={prefs[k] === o.v}
              onChange={() => set({ [k]: o.v } as Partial<Prefs>)}
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function SettingsPage({
  pairedAt,
  onSignedOut,
}: {
  pairedAt: string;
  onSignedOut: () => void;
  onOpenKill: () => void;
}) {
  const { prefs } = usePrefs();
  const policy = useResource('policy', api.policy);
  const [showPolicy, setShowPolicy] = useState(false);
  return (
    <div className="stack">
      <h1 tabIndex={-1}>Settings</h1>

      {HOSTED ? (
        <>
          <MachinesPanel />
          <AccountsPanel />
        </>
      ) : (
        <section className="kill-panel" aria-labelledby="kill-h">
          <h2 id="kill-h">Kill switch</h2>
          <KillControl big />
        </section>
      )}

      <section className="panel" aria-labelledby="calm-h">
        <h2 id="calm-h">Calm and rewards</h2>
        <Toggle k="calm" label="Calm mode" hint="no animation; rewards become a static tick (key m)" />
        <Toggle k="rewards" label="Rewards" hint="the two small marks for proven outcomes" />
        <div style={{ paddingLeft: 'var(--fw-space-5)' }}>
          <Toggle k="rewardTableCleared" label="Table cleared" disabled={!prefs.rewards} />
          <Toggle k="rewardCargoLanded" label="Cargo landed" disabled={!prefs.rewards} />
        </div>
        <Choice
          k="motion"
          label="Motion"
          options={[
            { v: 'system', label: 'Follow system' },
            { v: 'reduced', label: 'Reduced' },
          ]}
        />
      </section>

      <section className="panel" aria-labelledby="look-h">
        <h2 id="look-h">Appearance</h2>
        <Choice
          k="theme"
          label="Theme"
          options={[
            { v: 'system', label: 'System' },
            { v: 'light', label: 'Light' },
            { v: 'dark', label: 'Dark' },
          ]}
        />
        <Choice
          k="density"
          label="Table density"
          options={[
            { v: 'comfortable', label: 'Comfortable' },
            { v: 'compact', label: 'Compact' },
          ]}
        />
      </section>

      <section className="panel" aria-labelledby="keys-h">
        <h2 id="keys-h">Keyboard</h2>
        <Toggle k="shortcuts" label="Single-key shortcuts" hint="press ? for the list" />
        <Choice
          k="killMode"
          label="Kill switch"
          options={[
            { v: 'hold', label: 'Press and hold' },
            { v: 'arm', label: 'Arm, then confirm' },
          ]}
        />
      </section>

      <section className="panel" aria-labelledby="pol-h">
        <div className="panel-head">
          <h2 id="pol-h">Policy</h2>
          <span className="status status-neutral">
            <Icon name="lock" /> Locked. Human-only; edit the file, not this page.
          </span>
        </div>
        <ResourceView res={policy} what="policy">
          {(p) => (
            <>
              <dl className="facts">
                <dt>File</dt>
                <dd className="mono">{p.path}</dd>
                <dt>Commit</dt>
                <dd className="row">
                  <span className="hash">{shortHash(p.commit, 12, 4)}</span>{' '}
                  <Copy text={p.commit} label="policy commit" />
                </dd>
                <dt>sha256</dt>
                <dd className="hash">{shortHash(p.sha256, 12, 6)}</dd>
              </dl>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => setShowPolicy((v) => !v)}
                aria-expanded={showPolicy}
              >
                {showPolicy ? 'Hide the rules' : 'Show the rules'}
              </button>
              {showPolicy && (
                // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (WCAG 2.1.1)
                <pre className="output" tabIndex={0}>
                  {p.text}
                </pre>
              )}
            </>
          )}
        </ResourceView>
      </section>

      <section className="panel" aria-labelledby="sess-h">
        <h2 id="sess-h">Session</h2>
        <p>
          {HOSTED
            ? `Signed in as ${signedInEmail() ?? 'the owner'} since ${when(pairedAt)}.`
            : `This browser has been paired since ${when(pairedAt)}.`}
        </p>
        <button
          type="button"
          className="btn"
          onClick={async () => {
            try {
              await api.signOut();
            } finally {
              onSignedOut();
            }
          }}
        >
          Sign out
        </button>
      </section>
    </div>
  );
}
