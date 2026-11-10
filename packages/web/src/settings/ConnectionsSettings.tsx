// FW-C-094: email sending, the Frequency link and Google Analytics, from Settings. Each shows whether it is
// set up on the machine and the exact command for each missing piece. Secrets are never typed here: each
// command runs in the machine's terminal and asks for the secret there.
import { Fragment, type ReactNode } from 'react';
import { ApiError, api } from '../api/client';
import { useResource } from '../api/resource';
import type { ConnectionPart, Connections } from '../api/types';
import { Copy, ResourceView } from '../ui-kit/honest';
import { when } from '../ui-kit/time';
import { SenderForm } from './SenderForm';

function Part({
  id,
  title,
  part,
  hint,
  children,
  extra,
}: {
  id: string;
  title: string;
  part: ConnectionPart;
  hint: string;
  children: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <section className="connection" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      <p className={part.ready ? 'status status-ok' : 'status status-warn'}>
        {part.ready ? 'Ready' : 'Needs setup'}
      </p>
      <dl className="facts">{children}</dl>
      {extra}
      {part.fix.length > 0 && (
        <>
          <p className="setting-desc">{hint}</p>
          <ul className="connection-fix">
            {part.fix.map((cmd) => (
              <li key={cmd} className="row">
                <code>{cmd}</code> <Copy text={cmd} label={cmd} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

const yes = (b: boolean) => (b ? 'Saved' : 'Not saved');

function Body({ d, canChange, reload }: { d: Connections; canChange: boolean; reload: () => void }) {
  const { email, frequency, ga4 } = d;
  return (
    <>
      <Part
        id="conn-email"
        title="Email sending"
        part={email}
        hint="Run these in your terminal, in the FlowWeb folder. A command that saves a password asks for it there."
        extra={<SenderForm values={email.values ?? null} canChange={canChange} reload={reload} />}
      >
        <dt>Settings file</dt>
        <dd>{email.settings ? 'Found' : 'Not written yet'}</dd>
        {email.mailboxes.map((m) => (
          <Fragment key={m.address}>
            <dt>{m.address}</dt>
            <dd>Password {yes(m.password).toLowerCase()}</dd>
          </Fragment>
        ))}
        <dt>Postal address</dt>
        <dd>{email.postal ? 'Set' : 'Not set'}</dd>
        <dt>Sender</dt>
        <dd>
          {email.running
            ? `Running, last pass ${when(email.last_pass_at ?? '')}`
            : email.last_pass_at
              ? `Stopped, last pass ${when(email.last_pass_at)}`
              : 'Has not run here'}
        </dd>
        {email.claim_url && (
          <>
            <dt>Claim links</dt>
            <dd>Secret {yes(email.claim_secret).toLowerCase()}</dd>
          </>
        )}
      </Part>
      <Part
        id="conn-frequency"
        title="Frequency link"
        part={frequency}
        hint="Run this in your terminal and paste the same secret Frequency has as FLOWWEB_OUTCOMES_SECRET."
      >
        <dt>Site</dt>
        <dd>{frequency.site ?? "The flow's own link"}</dd>
        <dt>Shared secret</dt>
        <dd>{yes(frequency.outcomes_secret)}</dd>
      </Part>
      <Part
        id="conn-ga4"
        title="Google Analytics"
        part={ga4}
        hint="Download the service account's key file from Google Cloud, then run this with its path."
      >
        <dt>Property</dt>
        <dd>{ga4.property_id ?? 'None'}</dd>
        <dt>Key</dt>
        <dd>{yes(ga4.key)}</dd>
        <dt>Last pull</dt>
        <dd>
          {!ga4.last_pull
            ? 'None yet'
            : ga4.last_pull.ok
              ? `Worked ${when(ga4.last_pull.at)}`
              : `Failed ${when(ga4.last_pull.at)}${ga4.last_pull.error ? `: ${ga4.last_pull.error}` : ''}`}
        </dd>
      </Part>
    </>
  );
}

/** Settings, "Connections". Read only: what is set is read from the machine, and secrets stay there. */
export function ConnectionsSettings({ canChange = true }: { canChange?: boolean }) {
  const res = useResource('connections', () => api.connections(), []);
  const old = res.error instanceof ApiError && res.error.status === 404;
  return (
    <section className="settings-group" aria-labelledby="conn-h">
      <h2 id="conn-h">
        Connections
        <span className="setting-desc">
          Sending email, the Frequency link and Google Analytics. Secrets stay on your machine; each command
          asks for its secret in your terminal.
        </span>
      </h2>
      <div className="settings-body">
        <div className="panel settings-panel">
          {old ? (
            <p>Update FlowWeb on this machine to see its connections: git pull, then restart fwd.</p>
          ) : (
            <ResourceView res={res} what="connections">
              {(d) => <Body d={d} canChange={canChange} reload={res.reload} />}
            </ResourceView>
          )}
        </div>
      </div>
    </section>
  );
}
