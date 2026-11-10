import { api } from '../api/client';
import { useResource } from '../api/resource';
import type { Flow, FlowArea, FlowDecision } from '../api/types';
import { AsOf, ResourceView } from '../ui-kit/honest';
import { Figures, PageHead } from '../ui-kit/page';
import { StatusLabel, type StatusSpec } from '../ui-kit/status';
import { usd } from '../ui-kit/time';

const pct = (x: number) => `${Math.round(x * 100)}%`;

const DECISION: Record<FlowDecision['kind'], StatusSpec> = {
  keep_working: { word: 'Working', tone: 'active', icon: 'running' },
  propose_expansion: { word: 'Needs you: open the next ring', tone: 'attention', icon: 'waiting' },
  paused_budget: { word: 'Paused by the spend cap', tone: 'warn', icon: 'paused' },
  all_saturated: { word: 'Every ring saturated', tone: 'ok', icon: 'done' },
};

const PLACEHOLDER: Record<Flow['placeholders'][number], string> = {
  offer: 'what we are marketing and the call to action',
  starting_area: 'the starting area (Vista, CA is a guess)',
  channels: 'which channels to draft for',
};

/** Read-only view of one marketing flow. The flow drafts; only the Owner posts or sends. */
export function FlowPage({ flowKey }: { flowKey: string }) {
  const res = useResource(`flow:${flowKey}`, () => api.flow(flowKey), ['runs', 'cards']);
  const d = res.honesty === 'current' ? res.data : null;
  const openRing = d?.rings.find((r) => r.ring === d.open_ring);
  const unknown = <span className="fact-unknown">Unknown</span>;
  return (
    <>
      <PageHead
        overline="Flow · drafts only"
        title={res.data?.name ?? 'Marketing flow'}
        lede={
          <>
            Saturates one area, then opens the next ring around it. It researches and drafts; you approve and
            post. Nothing goes out without you.
            <span className="page-meta">
              <AsOf res={res} />
            </span>
          </>
        }
        aside={
          <Figures
            label="Flow at a glance"
            items={[
              {
                label: 'open ring',
                value: d ? d.open_ring : unknown,
                of: d ? `of ${d.rings.length - 1}` : undefined,
              },
              { label: 'ring saturation', value: openRing ? pct(openRing.average) : unknown },
              {
                label: 'drafts waiting for you',
                value: d ? d.awaiting_owner_total : unknown,
                tone: d && d.awaiting_owner_total > 0 ? 'waiting' : undefined,
              },
              {
                label: `spent this ${d?.budget.period ?? 'period'}`,
                value: d ? usd(d.budget.spent_usd) : unknown,
                of: d?.budget.max_usd != null ? `of ${usd(d.budget.max_usd)}` : undefined,
              },
            ]}
          />
        }
      />
      <ResourceView res={res} what="this flow">
        {(f) => (
          <div className="stack-lg">
            {f.placeholders.length > 0 && (
              <section className="panel" aria-labelledby="flow-ph">
                <h2 id="flow-ph">Waiting on your answers</h2>
                <p>Until you answer, this flow uses placeholders for:</p>
                <ul>
                  {f.placeholders.map((p) => (
                    <li key={p}>{PLACEHOLDER[p]}</li>
                  ))}
                </ul>
                <p className="muted">
                  {f.enabled ? 'The flow is on.' : 'The flow is off until these are set.'}
                </p>
              </section>
            )}

            <section className="panel" aria-labelledby="flow-next">
              <h2 id="flow-next">Next move</h2>
              <p>
                <StatusLabel spec={DECISION[f.decision.kind]} />
              </p>
              <p>{f.decision.summary}</p>
              {f.decision.kind === 'propose_expansion' && (
                <p className="muted">
                  The flow never opens a ring by itself. This becomes a card on your Table.
                </p>
              )}
              {f.plan.length > 0 && (
                <p>
                  This cycle works: {f.plan.map((p) => `${areaName(f, p.area_id)} (${p.reason})`).join(', ')}.
                </p>
              )}
            </section>

            {f.rings.map((r) => (
              <section key={r.ring} className="panel" aria-labelledby={`ring-${r.ring}`}>
                <div className="panel-head">
                  <h2 id={`ring-${r.ring}`}>{r.ring === 0 ? 'Ring 0: starting area' : `Ring ${r.ring}`}</h2>
                  <span className="spacer" />
                  <StatusLabel
                    spec={
                      r.open
                        ? { word: `Open · ${pct(r.average)} saturated`, tone: 'active', icon: 'open' }
                        : { word: 'Not open yet', tone: 'neutral', icon: 'lock' }
                    }
                  />
                </div>
                <AreaTable areas={r.areas} />
              </section>
            ))}

            <div className="grid-2">
              <section className="panel" aria-labelledby="flow-steps">
                <h2 id="flow-steps">Each cycle</h2>
                <ol>
                  {f.steps.map((s) => (
                    <li key={s.key}>
                      {s.label}
                      {s.outward && <strong> (only you do this)</strong>}
                    </li>
                  ))}
                </ol>
                <p className="muted">
                  Saturation blends reach, cadence and new members. A ring counts as saturated at{' '}
                  {pct(f.thresholds.threshold)} held for {f.thresholds.hold_cycles} cycles. At most{' '}
                  {f.thresholds.max_active_areas} areas are worked at once.
                </p>
              </section>
              <section className="panel" aria-labelledby="flow-channels">
                <h2 id="flow-channels">Channels</h2>
                <ul className="plain-list">
                  {f.channels.map((c) => (
                    <li key={c.key} className="row">
                      <span>{c.label}</span>
                      <span className="spacer" />
                      {c.placeholder && (
                        <StatusLabel plain spec={{ word: 'Placeholder', tone: 'unknown', icon: 'unknown' }} />
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            </div>

            <section className="panel" aria-labelledby="flow-engine">
              <h2 id="flow-engine">Engine and spend cap</h2>
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
          </div>
        )}
      </ResourceView>
    </>
  );
}

function areaName(f: Flow, id: string) {
  return f.rings.flatMap((r) => r.areas).find((a) => a.id === id)?.name ?? id;
}

function AreaTable({ areas }: { areas: FlowArea[] }) {
  return (
    <table className="data">
      <thead>
        <tr>
          <th>Area</th>
          <th className="num hide-narrow">Distance</th>
          <th>Saturation</th>
          <th className="num hide-narrow">Reached</th>
          <th className="num hide-narrow">New members, 28 days</th>
          <th className="num">Waiting</th>
        </tr>
      </thead>
      <tbody>
        {areas.map((a) => (
          <tr key={a.id}>
            <td>{a.name}</td>
            <td className="num hide-narrow">{a.km_from_seed} km</td>
            <td>
              <span className="flow-sat">
                {/* Decorative: the percentage beside it states the value. */}
                <span className="meter" aria-hidden="true">
                  <span className="meter-fill" style={{ width: pct(a.saturation.score) }} />
                </span>
                {pct(a.saturation.score)}
              </span>
            </td>
            <td className="num hide-narrow">
              {a.signals.targets_reached} of {a.signals.targets_known}
            </td>
            <td className="num hide-narrow">{a.signals.new_members_28d}</td>
            <td className="num">{a.awaiting_owner}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
