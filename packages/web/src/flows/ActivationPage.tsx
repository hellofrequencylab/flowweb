import { api } from '../api/client';
import { useResource } from '../api/resource';
import type {
  ActivationDecision,
  ActivationFlow,
  ActivationMeasures,
  ActivationTerritory,
  LeadStage,
  SendVia,
} from '../api/types';
import { AsOf, ResourceView } from '../ui-kit/honest';
import { Figures, PageHead } from '../ui-kit/page';
import { StatusLabel, type StatusSpec } from '../ui-kit/status';
import { usd } from '../ui-kit/time';
import { FlowAdmin } from './FlowAdmin';
import { MeasureDials, PipelineBar, RegionPath } from './FlowVisuals';
import { SupervisorPanel } from './SupervisorPanel';

const pct = (x: number) => `${Math.round(x * 100)}%`;
const num = (n: number) => n.toLocaleString('en-US');

const STATUS: Record<ActivationTerritory['status'], StatusSpec> = {
  active: { word: 'Active', tone: 'active', icon: 'running' },
  upkeep: { word: 'Upkeep', tone: 'ok', icon: 'done' },
  waiting: { word: 'Waiting', tone: 'neutral', icon: 'lock' },
};

const MEASURES: { key: keyof ActivationMeasures; label: string }[] = [
  { key: 'hosts_active_28d', label: 'Active hosts' },
  { key: 'events_next_14d', label: 'Events in the next 14 days' },
  { key: 'sub_areas_covered_14d', label: 'Sub-areas covered' },
  { key: 'wam', label: 'Weekly active members' },
];

const STAGES: { key: LeadStage; label: string }[] = [
  { key: 'invite', label: 'Invite' },
  { key: 'watch', label: 'Watch' },
  { key: 'post_only', label: 'Public post only' },
  { key: 'capped', label: 'Capped' },
  { key: 'blocked', label: 'Do not contact' },
  { key: 'drop', label: 'Dropped' },
];
const stageLabel = (s: LeadStage) => STAGES.find((x) => x.key === s)?.label ?? s;

const ROUTE: Record<SendVia, string> = { founder_email: 'Your email', frequency: 'Frequency' };

const PLACEHOLDER: Record<string, string> = {
  host_funnel: 'the host sign-up page (/start/host does not exist in Frequency yet)',
  inland_north: 'Inland North, which is a guess at the Temecula Valley',
  offer: 'what we are marketing and the call to action',
};

function decisionSpec(d: ActivationDecision, f: ActivationFlow): StatusSpec {
  switch (d.kind) {
    case 'keep_working':
      return { word: 'Working', tone: 'active', icon: 'running' };
    case 'propose_expansion':
      return { word: `Needs you: open ${regionName(f, d.territory_id)}`, tone: 'attention', icon: 'waiting' };
    case 'paused_budget':
      return { word: 'Paused by the spend cap', tone: 'warn', icon: 'paused' };
    case 'all_active':
      return { word: 'Every region is open', tone: 'ok', icon: 'done' };
  }
}

function regionName(f: ActivationFlow, id: string) {
  return f.territories.find((t) => t.id === id)?.name ?? id;
}

/** Neighborhood activation: works one region until it is active, then asks you before opening the next. */
export function ActivationPage() {
  const res = useResource('flow:neighborhood-activation', () => api.activationFlow(), ['runs', 'cards']);
  const d = res.honesty === 'current' ? res.data : null;
  const active = d?.territories.find((t) => t.status === 'active');
  const unknown = <span className="fact-unknown">Unknown</span>;
  return (
    <>
      <PageHead
        overline="Flow · drafts only"
        title={res.data?.name ?? 'Neighborhood activation'}
        lede={
          <>
            Gets one region active with hosts, events and members, then asks you before opening the next. It
            finds and drafts; you approve and send. Nothing goes out without you.
            <span className="page-meta">
              <AsOf res={res} />
            </span>
          </>
        }
        aside={
          <Figures
            label="Flow at a glance"
            items={[
              { label: 'active region', value: active ? active.name : unknown },
              {
                label: 'weakest measure',
                value: active?.progress != null ? pct(active.progress) : unknown,
              },
              {
                label: 'invites waiting for you',
                value: d ? d.awaiting_owner_total : unknown,
                tone: d && d.awaiting_owner_total > 0 ? 'waiting' : undefined,
              },
              {
                label: `spent this ${d?.budget.period ?? 'week'}`,
                value: d ? usd(d.budget.spent_usd) : unknown,
                of: d?.budget.max_usd != null ? `of ${usd(d.budget.max_usd)}` : undefined,
              },
            ]}
          />
        }
      />
      <SupervisorPanel />
      <ResourceView res={res} what="this flow">
        {(f) => (
          <div className="stack-lg">
            <section className="panel" aria-labelledby="na-next">
              <h2 id="na-next">Next move</h2>
              <p>
                <StatusLabel spec={decisionSpec(f.decision, f)} />
              </p>
              <p>{f.decision.summary}</p>
              {f.decision.kind === 'propose_expansion' && (
                <p className="muted">
                  The flow never opens a region by itself. This becomes a card on your Table.
                </p>
              )}
              {f.plan.sub_areas.length > 0 && (
                <p>
                  This cycle works:{' '}
                  {f.plan.sub_areas.map((p) => `${subAreaName(f, p.sub_area)} (${p.reason})`).join(', ')}.
                </p>
              )}
            </section>

            <section className="panel" aria-labelledby="na-path">
              <h2 id="na-path">Regions, in the order they open</h2>
              <RegionPath territories={f.territories} />
            </section>

            {f.placeholders.length > 0 && (
              <section className="panel" aria-labelledby="na-ph">
                <h2 id="na-ph">Waiting on your answers</h2>
                <p>Until you answer, this flow uses placeholders for:</p>
                <ul>
                  {f.placeholders.map((p) => (
                    <li key={p}>{PLACEHOLDER[p] ?? p.replaceAll('_', ' ')}</li>
                  ))}
                </ul>
                <p className="muted">
                  {f.enabled ? 'The flow is on.' : 'The flow is off until these are set.'}
                </p>
              </section>
            )}

            {[...f.territories]
              .sort((a, b) => a.order - b.order)
              .map((t) => (
                <Region key={t.id} t={t} holdWeeks={f.thresholds.hold_weeks} />
              ))}

            <section className="panel" aria-labelledby="na-leads">
              <h2 id="na-leads">Lead pipeline</h2>
              <PipelineBar stages={STAGES} counts={f.pipeline} label="Leads by stage" />
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Lead</th>
                      <th className="hide-narrow">Kind</th>
                      <th className="hide-narrow">Region</th>
                      <th>Stage</th>
                      <th className="hide-narrow">Why</th>
                      <th className="hide-narrow">Send by</th>
                      <th>Funnel</th>
                    </tr>
                  </thead>
                  <tbody>
                    {f.leads.map((l) => (
                      <tr key={l.id}>
                        <td>{l.name}</td>
                        <td className="hide-narrow">{l.kind}</td>
                        <td className="hide-narrow">{regionName(f, l.territory_id)}</td>
                        <td>{stageLabel(l.stage)}</td>
                        <td className="hide-narrow">{l.reason}</td>
                        <td className="hide-narrow">{l.send_via ? ROUTE[l.send_via] : 'None'}</td>
                        <td>
                          {l.funnel ? (
                            <a
                              href={l.funnel.url}
                              target="_blank"
                              rel="noopener"
                              title={l.funnel.path}
                              aria-label={`Open the funnel for ${l.name} in a new tab`}
                            >
                              Open
                            </a>
                          ) : (
                            <span className="muted">None</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="panel" aria-labelledby="na-send">
              <h2 id="na-send">How sends work</h2>
              <p>
                <strong>FlowWeb never sends anything. You send.</strong> It drafts each message with the right
                link, and you send it yourself by one of two routes.
              </p>
              <dl className="facts">
                <dt>{f.send_routes.founder_email.label}</dt>
                <dd>
                  For personal invites to hosts, venues and builders, one person at a time. Each one needs:{' '}
                  {(f.send_routes.founder_email.needs ?? []).join('; ')}.
                </dd>
                <dt>{f.send_routes.frequency.label}</dt>
                <dd>
                  For resident posts, bulk messages and follow-ups. Frequency adds{' '}
                  {(f.send_routes.frequency.adds ?? []).join(' and ')}.
                </dd>
              </dl>
            </section>

            <div className="grid-2">
              <section className="panel" aria-labelledby="na-steps">
                <h2 id="na-steps">Each cycle</h2>
                <ol>
                  {f.steps.map((s) => (
                    <li key={s.key}>
                      {s.label}
                      {s.outward && <strong> (only you do this)</strong>}
                    </li>
                  ))}
                </ol>
              </section>
              <section className="panel" aria-labelledby="na-sources">
                <h2 id="na-sources">Lead sources</h2>
                <ul className="plain-list">
                  {f.sources.map((s) => (
                    <li key={s.key}>
                      <strong>{s.label}</strong>: finds {s.finds}, reached through {s.reach}.
                    </li>
                  ))}
                </ul>
              </section>
            </div>

            <section className="panel" aria-labelledby="na-engine">
              <h2 id="na-engine">Engine and spend cap</h2>
              <dl className="facts">
                <dt>Writes with</dt>
                <dd>{f.engine.label}</dd>
                <dt>Fallback</dt>
                <dd>{f.engine.fallback}</dd>
                <dt>Runs on</dt>
                <dd>{f.engine.runs_on}</dd>
                <dt>Cap per {f.budget.period}</dt>
                <dd>
                  {f.budget.max_usd != null ? usd(f.budget.max_usd) : 'no dollar cap'}
                  {f.budget.max_turns != null ? `, ${f.budget.max_turns} model turns` : ''}. Used{' '}
                  {usd(f.budget.spent_usd)}
                  {f.budget.max_turns != null ? ` and ${f.budget.used_turns} turns` : ''}.
                </dd>
                <dt>Needs your approval</dt>
                <dd>{f.gate_on.map((g) => g.replaceAll('_', ' ')).join(', ')}</dd>
              </dl>
            </section>

            <section aria-labelledby="na-admin" className="stack">
              <h2 id="na-admin">Uploads and admin</h2>
              <FlowAdmin flow={f} refresh={res.reload} />
            </section>
          </div>
        )}
      </ResourceView>
    </>
  );
}

function subAreaName(f: ActivationFlow, id: string) {
  return f.territories.flatMap((t) => t.sub_areas).find((s) => s.id === id)?.name ?? id;
}

function Region({ t, holdWeeks }: { t: ActivationTerritory; holdWeeks: number }) {
  return (
    <section className="panel" aria-labelledby={`na-r-${t.id}`}>
      <div className="panel-head">
        <h2 id={`na-r-${t.id}`}>
          {t.order}. {t.name}
        </h2>
        <span className="spacer" />
        <StatusLabel spec={STATUS[t.status]} />
      </div>
      <MeasureDials t={t} measures={MEASURES} />
      <p className="muted">
        Held at target {t.weeks_at_threshold} of {holdWeeks} weeks. {num(t.population)} people.
      </p>
      <details>
        <summary>{t.sub_areas.length} sub-areas</summary>
        <ul>
          {t.sub_areas.map((s) => (
            <li key={s.id}>
              {s.name} ({num(s.population)})
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
