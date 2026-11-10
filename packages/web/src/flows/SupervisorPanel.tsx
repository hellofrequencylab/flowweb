import { api } from '../api/client';
import { useResource } from '../api/resource';
import type { Supervisor, SupervisorDial, SupervisorFlow, SupervisorGate } from '../api/types';
import { AsOf, ResourceView } from '../ui-kit/honest';
import { StatusLabel, type StatusSpec } from '../ui-kit/status';
import { usd } from '../ui-kit/time';

/** One word per gate, so a held flow always says why in plain English. */
const GATE: Record<SupervisorGate, StatusSpec> = {
  kill_switch: { word: 'Stopped by the kill switch', tone: 'stop', icon: 'halted' },
  supervisor_paused: { word: 'Supervisor paused', tone: 'warn', icon: 'paused' },
  flow_disabled: { word: 'Off', tone: 'neutral', icon: 'stopped' },
  no_engine: { word: 'No logic yet', tone: 'unknown', icon: 'unknown' },
  dial_unapproved: { word: 'Autopilot needs your confirm', tone: 'attention', icon: 'waiting' },
  cap_required: { word: 'Needs a spend cap', tone: 'warn', icon: 'blocked' },
  budget: { word: 'Spend cap reached', tone: 'warn', icon: 'paused' },
  open_asks: { word: 'Waiting on your answers', tone: 'attention', icon: 'waiting' },
  dormant: { word: 'Dormant: nothing to do', tone: 'neutral', icon: 'paused' },
  stalled: { word: 'Stalled: paused itself', tone: 'warn', icon: 'blocked' },
  wip: { word: 'At its run limit', tone: 'neutral', icon: 'clock' },
  not_due: { word: 'On, nothing due', tone: 'ok', icon: 'clock' },
  machine_busy: { word: 'Machine busy', tone: 'neutral', icon: 'clock' },
};

/** The dial, in the Owner's words. Core never sends at any stop. */
export const DIAL: Record<SupervisorDial, string> = {
  draft: 'Draft',
  copilot: 'Copilot',
  autopilot: 'Autopilot',
};

export function flowSpec(f: SupervisorFlow): StatusSpec {
  if (f.state === 'running') return { word: 'Running', tone: 'active', icon: 'running' };
  if (f.state === 'ready') return { word: 'Ready to run', tone: 'active', icon: 'ready' };
  return f.gate ? GATE[f.gate] : { word: 'Held', tone: 'unknown', icon: 'unknown' };
}

function cap(f: SupervisorFlow): string {
  const b = f.budget;
  if (!b) return 'Unknown';
  const spent = b.spent_usd == null ? 'Unknown' : usd(b.spent_usd);
  return b.max_usd == null ? `${spent}, no cap` : `${spent} of ${usd(b.max_usd)}`;
}

/** The Supervisor's flows as a table. Pure, so it can be tested without fwd. */
export function SupervisorFlows({ s }: { s: Supervisor }) {
  return (
    <>
      <p>
        {s.kill_switch
          ? 'The kill switch is engaged. Nothing runs until you release it.'
          : s.paused
            ? 'You paused the Supervisor. No flow starts until you resume it.'
            : `Runs up to ${s.max_concurrent} at once; ${s.running} running now.`}
      </p>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Flow</th>
              <th>Dial</th>
              <th>State</th>
              <th className="hide-narrow">Why</th>
              <th className="hide-narrow">Spent</th>
            </tr>
          </thead>
          <tbody>
            {s.flows.map((f) => (
              <tr key={f.key}>
                <td>{f.name}</td>
                <td>{DIAL[f.dial] ?? 'Draft'}</td>
                <td>
                  <StatusLabel spec={flowSpec(f)} plain />
                </td>
                <td className="hide-narrow">{f.reason}</td>
                <td className="hide-narrow">{cap(f)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">
        Change these under Controls at the top of this page. On Autopilot, Core still never sends: it hands
        finished items to your sending app.
      </p>
    </>
  );
}

/** Read-only: which flows the Supervisor would run, and the one gate holding each of the rest. */
export function SupervisorPanel() {
  const res = useResource('supervisor', () => api.supervisor(), ['runs', 'cards']);
  return (
    <section className="panel" aria-labelledby="sup-h">
      <h2 id="sup-h">Supervisor</h2>
      <p className="page-meta">
        <AsOf res={res} />
      </p>
      <ResourceView res={res} what="the Supervisor">
        {(s) => <SupervisorFlows s={s} />}
      </ResourceView>
    </section>
  );
}
