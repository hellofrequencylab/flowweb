import type { ReactNode } from 'react';
import { api } from '../api/client';
import type { useStatusResource } from '../api/live';
import { type Resource, useResource } from '../api/resource';
import type { ActivationFlow, ActivationMeasures, Envelope, Supervisor, SupervisorFlow } from '../api/types';
import { stateOf } from '../flows/drafts';
import { FlowPulse } from '../flows/FlowVisuals';
import { Link } from '../shell/router';
import { Icon, type IconName } from '../ui-kit/Icon';
import { age, clock } from '../ui-kit/time';
import './today.css';

/** Where each ask is worked. Both move to /inbox when the Inbox lands. */
export const TODAY_LINKS = { drafts: '/flows#drafts', decisions: '/table', flows: '/flows' } as const;

const num = (n: number) => n.toLocaleString('en-US');
const pct = (x: number) => `${Math.round(Math.max(0, Math.min(1, x)) * 100)}%`;
const unknown = <span className="fact-unknown">Unknown</span>;

const MEASURES: { key: keyof ActivationMeasures; label: string }[] = [
  { key: 'hosts_active_28d', label: 'Active hosts' },
  { key: 'events_next_14d', label: 'Events in the next 14 days' },
  { key: 'sub_areas_covered_14d', label: 'Sub-areas covered' },
  { key: 'wam', label: 'Weekly active members' },
];

type ReadyDrafts = Envelope & { ready: number; flows: number };

/** Drafts waiting for the Owner with nothing left blank and not yet sent, over every flow. */
async function readyDrafts(): Promise<ReadyDrafts> {
  const s = await api.supervisor();
  const lists = await Promise.all(s.flows.map((f) => api.flowDrafts(f.key)));
  const ready = lists.reduce((n, l) => n + l.drafts.filter((d) => stateOf(d) === 'Ready').length, 0);
  const asOf = [s.data_as_of, ...lists.map((l) => l.data_as_of)].sort()[0];
  return { data_as_of: asOf, ready, flows: s.flows.length };
}

/**
 * Home's answer to "what do I do now": what waits on you, how the open region is doing, and whether
 * each flow is working. Anything fwd did not answer reads Unknown, never zero.
 */
export function Today({ status, now }: { status: ReturnType<typeof useStatusResource>; now: number }) {
  const drafts = useResource('today:drafts', readyDrafts, ['runs', 'cards']);
  const sup = useResource('supervisor', () => api.supervisor(), ['runs', 'cards']);
  const act = useResource('flow:neighborhood-activation', () => api.activationFlow(), ['runs', 'cards']);
  const s = status.honesty === 'current' ? status.data : null;
  const d = drafts.honesty === 'current' ? drafts.data : null;

  return (
    <section className="today" aria-label="Today">
      <div className="today-asks">
        <Ask
          to={TODAY_LINKS.drafts}
          n={d ? d.ready : null}
          one="draft ready to send"
          many="drafts ready to send"
          icon="send"
          sub={
            !d
              ? drafts.honesty === 'loading'
                ? 'Checking the flows.'
                : 'fwd did not answer for the drafts.'
              : d.ready === 0
                ? `Nothing to send. Checked ${clock(d.data_as_of)}.`
                : 'Read, tweak, copy and send from your own email.'
          }
        />
        <Ask
          to={TODAY_LINKS.decisions}
          n={s ? s.cards_open : null}
          one="decision waiting"
          many="decisions waiting"
          icon="signoffs"
          sub={
            !s
              ? status.honesty === 'loading'
                ? 'Checking.'
                : 'fwd did not answer for the decisions.'
              : s.cards_open === 0
                ? `Nothing to decide. Checked ${clock(s.data_as_of)}.`
                : s.oldest_card_created_at
                  ? `Oldest waited ${age(s.oldest_card_created_at, now).replace(' ago', '')}.`
                  : 'Approve, choose or answer.'
          }
        />
      </div>
      <div className="today-grid">
        <RegionProgress res={act} />
        <FlowStates res={sup} />
      </div>
    </section>
  );
}

function Ask({
  to,
  n,
  one,
  many,
  icon,
  sub,
}: {
  to: string;
  n: number | null;
  one: string;
  many: string;
  icon: IconName;
  sub: ReactNode;
}) {
  return (
    <Link to={to} className={`today-ask${n == null ? ' is-unknown' : n > 0 ? ' is-waiting' : ''}`}>
      <span className="today-ask-icon" aria-hidden="true">
        <Icon name={icon} size={20} />
      </span>
      <span className="today-ask-main">
        <span className="today-ask-n">{n == null ? unknown : num(n)}</span>{' '}
        <span className="today-ask-what">{n === 1 ? one : many}</span>{' '}
        <span className="today-ask-sub">{sub}</span>
      </span>
      <Icon name="arrow-right" size={18} />
    </Link>
  );
}

/** The open region against each of its targets. */
function RegionProgress({ res }: { res: Resource<ActivationFlow> }) {
  const flow = res.honesty === 'current' ? res.data : null;
  const t = flow?.territories.find((x) => x.status === 'active') ?? null;
  return (
    <section className="panel today-card" aria-label="Region progress">
      <div className="panel-head">
        <div>
          <span className="overline">Open region</span>
          <h2>{t ? t.name : flow ? 'None open' : unknown}</h2>
        </div>
        {t && (
          <span className="today-card-meta">
            {t.progress == null ? <>Progress {unknown}</> : `${pct(t.progress)} of the way`}
          </span>
        )}
      </div>
      {!flow ? (
        <p className="small muted">
          {res.honesty === 'loading'
            ? 'Checking the region.'
            : 'Region progress is Unknown until fwd answers.'}
        </p>
      ) : !t ? (
        <p className="small muted">No region is open. You open the next one from Flows.</p>
      ) : (
        <ul className="today-measures">
          {MEASURES.map(({ key, label }) => {
            const target = t.targets[key];
            const v = t.measures ? t.measures[key] : null;
            const share = v == null || !target ? 0 : Math.min(1, v / target);
            return (
              <li key={key} className={v == null ? 'is-unknown' : share >= 1 ? 'is-met' : undefined}>
                <span className="today-measure-label">{label}</span>{' '}
                <span className="today-measure-value">
                  {v == null ? (
                    <>
                      {unknown} <span className="muted">target {num(target)}</span>
                    </>
                  ) : (
                    `${num(v)} of ${num(target)}`
                  )}
                </span>{' '}
                <span className="today-bar" aria-hidden="true">
                  <span className="today-bar-fill" style={{ width: pct(share) }} />
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <Link to={TODAY_LINKS.flows} className="small">
        Regions and leads on Flows
      </Link>
    </section>
  );
}

const WORD: Record<SupervisorFlow['state'], string> = { running: 'Running', ready: 'Ready', held: 'Held' };

/** Each flow: is it working, and if not, the one reason. */
function FlowStates({ res }: { res: Resource<Supervisor> }) {
  const sup = res.honesty === 'current' ? res.data : null;
  return (
    <section className="panel today-card" aria-labelledby="today-flows">
      <div className="panel-head">
        <div>
          <span className="overline">Right now</span>
          <h2 id="today-flows">Your flows</h2>
        </div>
        {sup?.paused && <span className="today-card-meta today-paused">All flows paused</span>}
      </div>
      {!sup ? (
        <p className="small muted">
          {res.honesty === 'loading' ? 'Checking the flows.' : 'Flow states are Unknown until fwd answers.'}
        </p>
      ) : sup.flows.length === 0 ? (
        <p className="small muted">No flows are set up yet.</p>
      ) : (
        <ul className="today-flows" aria-label="Flows">
          {sup.flows.map((f) => (
            <li key={f.key}>
              <FlowPulse state={f.state} word={WORD[f.state]} />{' '}
              <span className="today-flow-main">
                <span className="today-flow-name">{f.name}</span>{' '}
                {f.reason && <span className="today-flow-reason">{f.reason}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <Link to={TODAY_LINKS.flows} className="small">
        Flow controls
      </Link>
    </section>
  );
}
