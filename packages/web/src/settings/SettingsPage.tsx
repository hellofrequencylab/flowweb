import { type ReactNode, useId, useState } from 'react';
import { api } from '../api/client';
import { useResource } from '../api/resource';
import { HOSTED, signedInEmail } from '../hosted/auth';
import { AccountsPanel, MachinesPanel } from '../hosted/Machines';
import { PeoplePanel } from '../hosted/People';
import { KillControl } from '../shell/KillSwitch';
import { type Prefs, usePrefs } from '../shell/prefs';
import { Copy, ResourceView } from '../ui-kit/honest';
import { Icon } from '../ui-kit/Icon';
import { PageHead } from '../ui-kit/page';
import { shortHash, when } from '../ui-kit/time';

function Toggle({
  k,
  label,
  hint,
  disabled,
  nested,
}: {
  k: keyof Prefs;
  label: string;
  hint?: string;
  disabled?: boolean;
  nested?: boolean;
}) {
  const { prefs, set } = usePrefs();
  const id = useId();
  const on = Boolean(prefs[k]);
  return (
    <div className={`setting${nested ? ' setting-nested' : ''}`}>
      <span className="setting-text">
        <span className="setting-label" id={`${id}-l`}>
          {label}
        </span>
        {hint && (
          <span className="setting-desc" id={`${id}-d`}>
            {hint}
          </span>
        )}
        {disabled && <span className="setting-desc">Turn Rewards on first.</span>}
      </span>
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={on}
        aria-labelledby={`${id}-l`}
        aria-describedby={hint ? `${id}-d` : undefined}
        disabled={disabled}
        onClick={() => set({ [k]: !on } as Partial<Prefs>)}
      >
        <span className="switch-knob" />
      </button>
    </div>
  );
}

function Choice<K extends keyof Prefs>({
  k,
  label,
  hint,
  options,
}: {
  k: K;
  label: string;
  hint?: string;
  options: { v: Prefs[K]; label: string }[];
}) {
  const { prefs, set } = usePrefs();
  return (
    <fieldset className="setting setting-choice">
      <legend className="visually-hidden">{label}</legend>
      <span className="setting-text" aria-hidden="true">
        <span className="setting-label">{label}</span>
        {hint && <span className="setting-desc">{hint}</span>}
      </span>
      <span className="segmented">
        {options.map((o) => (
          <label key={String(o.v)}>
            <input
              type="radio"
              name={String(k)}
              checked={prefs[k] === o.v}
              onChange={() => set({ [k]: o.v } as Partial<Prefs>)}
            />
            {o.label}
          </label>
        ))}
      </span>
    </fieldset>
  );
}

function Group({
  id,
  title,
  desc,
  children,
}: {
  id: string;
  title: string;
  desc?: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-group" aria-labelledby={id}>
      <h2 id={id}>
        {title}
        {desc && <span className="setting-desc">{desc}</span>}
      </h2>
      <div className="settings-body">{children}</div>
    </section>
  );
}

/**
 * Display preferences the Owner sets once. Calm mode stays in view; rewards, motion, theme,
 * density and keys fold under Look and feel, closed by default, so Settings leads with what he comes for.
 */
function LookAndFeel() {
  const { prefs } = usePrefs();
  const [open, setOpen] = useState(false);
  return (
    <section className="settings-group settings-fold" aria-labelledby="look-h">
      <h2 id="look-h" className="settings-fold-head">
        <button
          type="button"
          className="settings-fold-toggle"
          aria-expanded={open}
          aria-controls="look-body"
          onClick={() => setOpen((v) => !v)}
        >
          <span>
            Look and feel
            <span className="setting-desc">Rewards, motion, theme, density and keyboard.</span>
          </span>
          <span className="settings-fold-chevron">
            <Icon name="chevron-down" />
          </span>
        </button>
      </h2>
      <div className="panel settings-panel">
        <Toggle k="calm" label="Calm mode" hint="No animation; rewards become a static tick. Key m." />
      </div>
      {open && (
        <div className="settings-body" id="look-body">
          <div className="panel settings-panel">
            <Toggle k="rewards" label="Rewards" hint="The two small marks for proven outcomes." />
            <Toggle k="rewardTableCleared" label="All signed off" disabled={!prefs.rewards} nested />
            <Toggle k="rewardCargoLanded" label="Landed and proven" disabled={!prefs.rewards} nested />
            <Choice
              k="motion"
              label="Motion"
              options={[
                { v: 'system', label: 'Follow system' },
                { v: 'reduced', label: 'Reduced' },
              ]}
            />
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
            <Toggle k="shortcuts" label="Single-key shortcuts" hint="Press ? for the list." />
            <Choice
              k="killMode"
              label="Kill switch"
              hint="How the Stop button asks you to mean it."
              options={[
                { v: 'hold', label: 'Press and hold' },
                { v: 'arm', label: 'Arm, then confirm' },
              ]}
            />
          </div>
        </div>
      )}
    </section>
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
  const policy = useResource('policy', api.policy);
  const [showPolicy, setShowPolicy] = useState(false);
  return (
    <>
      <PageHead title="Settings" lede="Preferences live in this browser. Rules live in the policy file." />

      <Group id="kill-h" title="Kill switch" desc="Also in the top bar, and Ctrl+Shift+. anywhere.">
        <KillControl />
      </Group>

      {HOSTED && (
        <>
          <AccountsPanel />
          <MachinesPanel />
          <PeoplePanel />
        </>
      )}

      <Group id="sess-h" title="Session">
        <div className="panel">
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
            <Icon name="log-out" /> Sign out
          </button>
        </div>
      </Group>

      <LookAndFeel />

      <Group id="pol-h" title="Policy" desc="Locked. Human-only; edit the file, not this page.">
        <div className="panel">
          <p className="status status-neutral">
            <Icon name="lock" /> Read-only here
          </p>
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
        </div>
      </Group>
    </>
  );
}
