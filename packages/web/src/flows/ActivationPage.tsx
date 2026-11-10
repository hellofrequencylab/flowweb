import type { ReactNode } from 'react';
import { ApiError, api } from '../api/client';
import { useResource } from '../api/resource';
import type {
  ActivationDecision,
  ActivationFlow,
  ActivationMeasures,
  ActivationTerritory,
  LeadStage,
  SendVia,
} from '../api/types';
import { Gauge, IconTile } from '../ui-kit/flow';
import { AsOf, ResourceView } from '../ui-kit/honest';
import { PageHead } from '../ui-kit/page';
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

/** A quiet open and close control: the summary is a small pill, the body stays out of the way until asked. */
function Fold({
  label,
  hint,
  open = false,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="fold" open={open}>
      <summary>
        <span className="fold-label">{label}</span>
        {hint && <span className="fold-hint">{hint}</span>}
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}

/** Neighborhood activation: works one region until it is active, then asks you before opening the next. */
export function ActivationPage() {
  const res = useResource('flow:neighborhood-activation', () => api.activationFlow(), ['runs', 'cards']);
  const d = res.honesty === 'current' ? res.data : null;
  const active = d?.territories.find((t) => t.status === 'active');
  return (
    <>
      <PageHead
        overline="Flow · drafts only"
        title={res.data?.name ?? 'Neighborhood activation'}
        lede={
          <>
            Gets one region active, then asks you before opening the next. It finds and drafts; you approve
            and send.
            <span className="page-meta">
              <AsOf res={res} />
            </span>
          </>
        }
      />
      <ul className="kpis" aria-label="Flow at a glance">
        <li className="kpi">
          <IconTile name="flow" tone="brand" />
          <span className="kpi-text">
            <span className="kpi-value">{active ? active.name : 'Unknown'}</span>
            <span className="kpi-label">active region</span>
          </span>
        </li>
        <li className="kpi">
          <Gauge
            size={60}
            value={active?.progress ?? null}
            cap={1}
            label="Weakest measure in the active region"
            valueText={active?.progress != null ? `${pct(active.progress)} of target` : undefined}
            center={null}
          />
          <span className="kpi-text">
            <span className="kpi-value">{active?.progress != null ? pct(active.progress) : 'Unknown'}</span>
            <span className="kpi-label">weakest measure</span>
          </span>
        </li>
        <li className={`kpi${d && d.awaiting_owner_total > 0 ? ' is-waiting' : ''}`}>
          <IconTile name="waiting" tone={d && d.awaiting_owner_total > 0 ? 'waiting' : 'neutral'} />
          <span className="kpi-text">
            <span className="kpi-value">{d ? d.awaiting_owner_total : 'Unknown'}</span>
            <span className="kpi-label">invites waiting for you</span>
          </span>
        </li>
        <li className="kpi">
          <Gauge
            size={60}
            value={d ? d.budget.spent_usd : null}
            cap={d?.budget.max_usd ?? Math.max(1, d?.budget.spent_usd ?? 1)}
            label={`Spent this ${d?.budget.period ?? 'week'}`}
            valueText={
              d
                ? `${usd(d.budget.spent_usd)}${d.budget.max_usd != null ? ` of ${usd(d.budget.max_usd)}` : ', no cap'}`
                : undefined
            }
            center={null}
          />
          <span className="kpi-text">
            <span className="kpi-value">{d ? usd(d.budget.spent_usd) : 'Unknown'}</span>
            <span className="kpi-label">
              spent this {d?.budget.period ?? 'week'}
              {d?.budget.max_usd != null ? ` of ${usd(d.budget.max_usd)}` : ''}
            </span>
          </span>
        </li>
      </ul>
      <ResourceView res={res} what="this flow">
        {(f) => (
          <div className="stack flows-page">
            <section className="panel" aria-labelledby="na-next">
              <div className="panel-head">
                <h2 id="na-next">Now</h2>
                <StatusLabel spec={decisionSpec(f.decision, f)} />
              </div>
              <p>{f.decision.summary}</p>
              {f.decision.kind === 'propose_expansion' && (
                <p className="muted small">
                  The flow never opens a region by itself. This becomes a card in Sign-offs.
                </p>
              )}
              <RegionPath territories={f.territories} />
              {f.plan.sub_areas.length > 0 && (
                <Fold label="This cycle works" hint={`${f.plan.sub_areas.length} sub-areas`}>
                  <ul className="chip-list">
                    {f.plan.sub_areas.map((p) => (
                      <li key={p.sub_area}>
                        <strong>{subAreaName(f, p.sub_area)}</strong>{' '}
                        <span className="muted">{p.reason}</span>
                      </li>
                    ))}
                  </ul>
                </Fold>
              )}
              {f.placeholders.length > 0 && (
                <Fold
                  label="Waiting on your answers"
                  hint={`${f.placeholders.length} placeholder${f.placeholders.length === 1 ? '' : 's'}${f.enabled ? '' : ' · flow off until set'}`}
                >
                  <ul className="small">
                    {f.placeholders.map((p) => (
                      <li key={p}>{PLACEHOLDER[p] ?? p.replaceAll('_', ' ')}</li>
                    ))}
                  </ul>
                </Fold>
              )}
              <Fold label="Supervisor and dial" hint="which flows run, and why the rest are held">
                <SupervisorPanel />
              </Fold>
            </section>

            <section aria-labelledby="na-regions">
              <h2 id="na-regions" className="section-title">
                Regions
              </h2>
              <div className="region-grid">
                {[...f.territories]
                  .sort((a, b) => a.order - b.order)
                  .map((t) => (
                    <Region key={t.id} t={t} holdWeeks={f.thresholds.hold_weeks} />
                  ))}
              </div>
            </section>

            <DraftsPanel />

            <section className="panel" aria-labelledby="na-leads">
              <div className="panel-head">
                <h2 id="na-leads">Lead pipeline</h2>
                <span className="asof">{f.leads.length} leads</span>
              </div>
              <PipelineBar stages={STAGES} counts={f.pipeline} label="Leads by stage" />
              <Fold label="Show every lead" hint="who, why, and how you'd send">
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
              </Fold>
            </section>

            <section className="panel" aria-labelledby="na-how">
              <h2 id="na-how">How this flow works</h2>
              <p className="small">
                <strong>FlowWeb never sends anything. You send.</strong> It drafts each message with the right
                link, and you send it yourself.
              </p>
              <Fold label="How sends work" hint="two routes">
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
              </Fold>
              <Fold label="Each cycle" hint={`${f.steps.length} steps`}>
                <ol className="small">
                  {f.steps.map((s) => (
                    <li key={s.key}>
                      {s.label}
                      {s.outward && <strong> (only you do this)</strong>}
                    </li>
                  ))}
                </ol>
              </Fold>
              <Fold label="Lead sources" hint={`${f.sources.length} sources`}>
                <ul className="plain-list small">
                  {f.sources.map((s) => (
                    <li key={s.key}>
                      <strong>{s.label}</strong>: finds {s.finds}, reached through {s.reach}.
                    </li>
                  ))}
                </ul>
              </Fold>
              <Fold label="Engine and spend cap" hint={f.engine.label}>
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
              </Fold>
            </section>

            <section aria-labelledby="na-admin" className="panel">
              <h2 id="na-admin">Uploads and admin</h2>
              <Fold label="Upload leads or metrics, edit targets" hint="also raw config and the admin log">
                <div className="stack">
                  <FlowAdmin flow={f} refresh={res.reload} />
                </div>
              </Fold>
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
    <section
      className={`panel region-card${t.status === 'active' ? ' is-active' : ''}`}
      aria-labelledby={`na-r-${t.id}`}
    >
      <div className="panel-head">
        <h3 id={`na-r-${t.id}`}>
          <span className="region-order">{t.order}</span> {t.name}
        </h3>
        <StatusLabel spec={STATUS[t.status]} />
      </div>
      {t.measures ? (
        <MeasureDials t={t} measures={MEASURES} compact />
      ) : (
        <p className="small muted">
          No measures yet. Targets:{' '}
          {MEASURES.map(({ key, label }) => `${num(t.targets[key])} ${label.toLowerCase()}`).join(' · ')}.
        </p>
      )}
      <p className="xs muted">
        Held at target {t.weeks_at_threshold} of {holdWeeks} weeks · {num(t.population)} people
      </p>
      <Fold label={`${t.sub_areas.length} sub-areas`}>
        <ul className="chip-list">
          {t.sub_areas.map((s) => (
            <li key={s.id}>
              {s.name} <span className="muted">{num(s.population)}</span>
            </li>
          ))}
        </ul>
      </Fold>
    </section>
  );
}

const DRAFT_STATUS: Record<string, string> = {
  waiting_for_owner: 'Waiting for you',
  approved: 'Approved',
  rejected: 'Rejected',
};

/** The messages the flow's cycles drafted. FlowWeb never sends them; you copy and send. */
function DraftsPanel() {
  const res = useResource(
    'flow-drafts:neighborhood-activation',
    () => api.flowDrafts('neighborhood-activation'),
    ['runs'],
  );
  const drafts = res.data?.drafts ?? [];
  const waiting = drafts.filter((x) => x.status === 'waiting_for_owner').length;
  const cliOnly = res.error instanceof ApiError && res.error.status === 403;
  return (
    <section className="panel" aria-labelledby="na-drafts">
      <div className="panel-head">
        <h2 id="na-drafts">Drafts</h2>
        <span className="asof">{res.data ? `${waiting} waiting for you` : <AsOf res={res} />}</span>
      </div>
      {cliOnly ? (
        <p className="muted">
          On this machine, list drafts with <code>pnpm fw supervisor drafts neighborhood-activation</code>.
          flowweb.app shows them here.
        </p>
      ) : (
        <ResourceView res={res} what="the drafts">
          {(d) =>
            d.drafts.length === 0 ? (
              <p className="muted">No drafts yet. They appear here after the flow runs.</p>
            ) : (
              <ul className="stack drafts-list" aria-label="Drafts">
                {d.drafts.map((x) => (
                  <li key={x.id}>
                    <Fold
                      label={x.subject ?? 'Untitled draft'}
                      hint={`${DRAFT_STATUS[x.status] ?? x.status}${x.created_at ? ` · ${x.created_at.slice(0, 10)}` : ''}`}
                      open={d.drafts.length <= 3}
                    >
                      <pre className="draft-body">{x.body}</pre>
                    </Fold>
                  </li>
                ))}
              </ul>
            )
          }
        </ResourceView>
      )}
    </section>
  );
}
