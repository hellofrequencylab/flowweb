import { type ReactNode, useEffect } from 'react';
import { api } from '../api/client';
import { useResource } from '../api/resource';
import type {
  ActivationDecision,
  ActivationFlow,
  ActivationMeasures,
  ActivationTerritory,
  LeadStage,
  SendVia,
  Supervisor,
} from '../api/types';
import { Link } from '../shell/router';
import { Gauge, IconTile } from '../ui-kit/flow';
import { AsOf, ResourceView } from '../ui-kit/honest';
import { type Loop, type LoopInfo, LoopProvider, useLoopTarget } from '../ui-kit/loop';
import { PageHead } from '../ui-kit/page';
import { StatusLabel, type StatusSpec } from '../ui-kit/status';
import { usd } from '../ui-kit/time';
import { DraftsInbox } from './DraftsInbox';
import { EventIntake } from './EventIntake';
import { FlowControls } from './FlowControls';
import { FlowHero } from './FlowHero';
import { FlowPulse, MeasureDials, PipelineBar, type PulseState, RegionPath } from './FlowVisuals';
import { flowLoop, flowSpec } from './flowState';
import { LeadHunts } from './LeadHunts';
import { PaidAdsPanel } from './PaidAdsPanel';
import { ReplyHelper } from './ReplyHelper';
import { Today } from './Today';
import { WhatsWorking } from './WhatsWorking';

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

const KEY = 'neighborhood-activation';

/** Whether a cycle is working right now, from the Supervisor. Only a current read can say "running". */
function pulseOf(s: Supervisor | null): { state: PulseState; word: string } {
  const f = s?.flows.find((x) => x.key === KEY);
  if (!f) return { state: 'unknown', word: 'Unknown: no word from the Supervisor' };
  if (f.state === 'running') return { state: 'running', word: 'Running a cycle now' };
  if (f.state === 'ready') return { state: 'ready', word: 'Ready: starts on the next turn' };
  return { state: 'held', word: `Idle: ${flowSpec(f).word}` };
}

/** A chapter of the page: a numbered display heading over a hairline. The panels after it belong to it. */
function ChapterHead({ n, id, title, lede }: { n: number; id: string; title: string; lede: string }) {
  return (
    <header className="chapter-head">
      <span className="chapter-num" aria-hidden="true">
        {String(n).padStart(2, '0')}
      </span>
      <div>
        <h2 id={id}>{title}</h2>
        <p className="chapter-lede">{lede}</p>
      </div>
    </header>
  );
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

/** Where a flow opened from home lands on this page: paid ads has its own chapter; others start at the top. */
const FLOW_ANCHOR: Record<string, string> = { 'paid-ads': 'na-ads' };

/**
 * Neighborhood activation: works one region until it is active, then asks you before opening the next.
 * `flow` is the key from /flows/<key>; a flow shown inside this page scrolls to its own chapter.
 */
export function ActivationPage({ flow }: { flow?: string } = {}) {
  const res = useResource('flow:neighborhood-activation', () => api.activationFlow(), ['runs', 'cards']);
  const d = res.honesty === 'current' ? res.data : null;
  const anchor = flow ? FLOW_ANCHOR[flow] : undefined;
  const loaded = d != null;
  useEffect(() => {
    if (anchor && loaded) document.getElementById(anchor)?.scrollIntoView({ block: 'start' });
  }, [anchor, loaded]);
  const active = d?.territories.find((t) => t.status === 'active');
  const sup = useResource('supervisor', () => api.supervisor(), ['runs', 'cards']);
  const pulse = pulseOf(sup.honesty === 'current' ? sup.data : null);
  const live = pulse.state === 'running';
  // FW-C-098: the flow's loop state from a current read only; Unknown draws no state at all.
  const supNow = sup.honesty === 'current' ? sup.data : null;
  const loop: Loop | undefined = supNow ? flowLoop(supNow.flows.find((x) => x.key === KEY)) : undefined;
  return (
    <LoopProvider>
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
        aside={<FlowPulse {...pulse} />}
      />
      <FlowHero flowKey={flow ?? KEY} />
      <ul className="kpis" aria-label="Flow at a glance">
        <Kpi
          live={live}
          info={
            loop && {
              title: 'Active region',
              loop,
              what: 'The region the flow is working on now. It finds and drafts here until the region is fully active.',
              why: active ? `${active.name}.` : 'No active region yet.',
            }
          }
        >
          <IconTile name="flow" tone="brand" />
          <span className="kpi-text">
            <span className="kpi-value">{active ? active.name : 'Unknown'}</span>
            <span className="kpi-label">active region</span>
          </span>
        </Kpi>
        <li className={`kpi${live ? ' is-live live-edge' : ''}`}>
          <Gauge
            loop={
              loop && {
                title: 'Weakest measure',
                loop,
                what: 'How close the active region is to fully active, read from its weakest measure.',
                why: active?.progress != null ? `${pct(active.progress)} of target.` : 'No reading yet.',
              }
            }
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
        <Kpi
          live={live}
          extra={d && d.awaiting_owner_total > 0 ? 'is-waiting' : ''}
          info={
            loop && {
              title: 'Invites waiting for you',
              loop: d && d.awaiting_owner_total > 0 ? 'waiting' : loop === 'working' ? 'connected' : loop,
              what: 'Drafts the flow wrote that wait for you to read, edit and send. Nothing goes out on its own.',
              why: d ? `${d.awaiting_owner_total} waiting.` : undefined,
            }
          }
        >
          <IconTile name="waiting" tone={d && d.awaiting_owner_total > 0 ? 'waiting' : 'neutral'} />
          <span className="kpi-text">
            <span className="kpi-value">{d ? d.awaiting_owner_total : 'Unknown'}</span>
            <span className="kpi-label">invites waiting for you</span>
          </span>
        </Kpi>
        <li className={`kpi${live ? ' is-live live-edge' : ''}`}>
          <Gauge
            loop={
              loop && {
                title: 'Spend this period',
                loop:
                  d && d.budget.max_usd != null && d.budget.spent_usd >= d.budget.max_usd ? 'broken' : loop,
                what: 'What the flow spent on AI this period, against its cap. At the cap the flow stops until the period ends.',
                why: d
                  ? `${usd(d.budget.spent_usd)}${d.budget.max_usd != null ? ` of ${usd(d.budget.max_usd)}` : ', no cap'}.`
                  : undefined,
              }
            }
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
      <div className="flow-ctl">
        <FlowControls />
      </div>
      <ResourceView res={res} what="this flow">
        {(f) => (
          <div className="stack flows-page">
            <ChapterHead
              n={1}
              id="na-now"
              title="Right now"
              lede="Lines flow fast while a cycle works and slowly while the flow is on. Tap any node or line to see what it is."
            />
            <section className={`panel${live ? ' is-live' : ''}`} aria-labelledby="na-next">
              <div className="panel-head">
                <h3 id="na-next">Where the flow is</h3>
                <StatusLabel spec={decisionSpec(f.decision, f)} />
              </div>
              <p>{f.decision.summary}</p>
              {f.decision.kind === 'propose_expansion' && (
                <p className="muted small">
                  The flow never opens a region by itself. This becomes a card in Sign-offs.
                </p>
              )}
              <RegionPath territories={f.territories} live={live} loop={loop} />
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
            </section>

            <ChapterHead
              n={2}
              id="na-regions"
              title="Regions"
              lede="Opened one at a time, in this order, and only with your OK."
            />
            <section aria-labelledby="na-regions">
              <div className="region-grid">
                {[...f.territories]
                  .sort((a, b) => a.order - b.order)
                  .map((t) => (
                    <Region
                      key={t.id}
                      t={t}
                      holdWeeks={f.thresholds.hold_weeks}
                      live={live}
                      loop={regionLoop(t, loop)}
                    />
                  ))}
              </div>
            </section>

            <ChapterHead
              n={3}
              id="na-yours"
              title="Waiting on you"
              lede="Messages to check and send, and the hunts that find more people."
            />
            <Today flow={KEY} />
            <DraftsInbox flow={KEY} />
            <LeadHunts regions={f.territories.map((t) => ({ id: t.id, name: t.name }))} />
            <ReplyHelper flow={KEY} />
            <EventIntake flow={KEY} />

            <ChapterHead
              n={4}
              id="na-reach"
              title="Reach"
              lede="Who the flow has found, and what is working."
            />
            <WhatsWorking flow={KEY} />
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

            <ChapterHead
              n={5}
              id="na-ads"
              title="Paid ads"
              lede="Its own flow: one Google Ads campaign, read only. You change the campaign in Google Ads."
            />
            <PaidAdsPanel />

            <ChapterHead
              n={6}
              id="na-runs"
              title="How it runs"
              lede="The rules and the engine behind this flow."
            />
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
              <div className="panel-head">
                <h2 id="na-admin">Admin</h2>
                <Link to="/growth/admin">Open admin</Link>
              </div>
              <p className="small muted">
                Upload leads or metrics, open the next region, change targets, edit the raw config and read
                the admin log. These live on their own page so this one stays a daily view.
              </p>
            </section>
          </div>
        )}
      </ResourceView>
    </LoopProvider>
  );
}

/** FW-C-098: a region's dials take the flow's state once the flow has reached it; one not opened waits. */
function regionLoop(t: ActivationTerritory, loop: Loop | undefined): Loop | undefined {
  if (!loop) return undefined;
  if (t.status === 'waiting') return 'waiting';
  return t.status === 'upkeep' && loop === 'working' ? 'connected' : loop;
}

/** A figure tile that takes the flow's loop state and says what it is on click. */
function Kpi({
  live,
  extra = '',
  info,
  children,
}: {
  live: boolean;
  extra?: string;
  info: LoopInfo | undefined;
  children: ReactNode;
}) {
  const target = useLoopTarget();
  const cls = `kpi${extra ? ` ${extra}` : ''}${live ? ' is-live live-edge' : ''}`;
  return info ? <li {...target(info, cls)}>{children}</li> : <li className={cls}>{children}</li>;
}

function subAreaName(f: ActivationFlow, id: string) {
  return f.territories.flatMap((t) => t.sub_areas).find((s) => s.id === id)?.name ?? id;
}

function Region({
  t,
  holdWeeks,
  live,
  loop,
}: {
  t: ActivationTerritory;
  holdWeeks: number;
  live: boolean;
  loop?: Loop;
}) {
  const here = t.status === 'active';
  return (
    <section
      className={`panel region-card${here ? ' is-active' : ''}${here && live ? ' is-live' : ''}`}
      aria-labelledby={`na-r-${t.id}`}
    >
      <div className="panel-head">
        <h3 id={`na-r-${t.id}`}>
          <span className="region-order">{t.order}</span> {t.name}
        </h3>
        <StatusLabel spec={STATUS[t.status]} />
      </div>
      {t.measures ? (
        <MeasureDials t={t} measures={MEASURES} compact loop={loop} />
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
