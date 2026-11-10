import { api } from '../api/client';
import { useResource } from '../api/resource';
import { Link } from '../shell/router';
import { FlowRing, hueAt } from '../ui-kit/flow';
import { Icon } from '../ui-kit/Icon';
import { draftCounts, FLOW_STAGES, positionOf } from './FlowsHome';
import { DIAL } from './flowState';
import './flows-home.css';

/**
 * The top of one flow's page: a way back to the Supervisor, and the flow as a large ring through its five
 * stages, its state, dial, draft counts and the one reason it is where it is. Finds are not counted, so no
 * stage shows a made-up zero.
 */
export function FlowHero({ flowKey }: { flowKey: string }) {
  const sup = useResource('supervisor', () => api.supervisor(), ['runs', 'cards']);
  const counts = useResource('home:drafts', draftCounts, ['runs', 'cards']);
  const s = sup.honesty === 'current' ? sup.data : null;
  const i = s ? s.flows.findIndex((f) => f.key === flowKey) : -1;
  const f = s && i >= 0 ? s.flows[i] : null;
  const c = counts.honesty === 'current' && counts.data ? counts.data.byFlow[flowKey] : null;
  const p = f ? positionOf(f, c) : null;
  return (
    <section className="flow-hero" aria-label="Where this flow is">
      <Link to="/" className="flow-hero-back">
        <Icon name="arrow-left" size={16} /> All flows
      </Link>
      <div className="flow-hero-body">
        <FlowRing
          hue={hueAt(Math.max(0, i))}
          at={p?.at ?? 0}
          state={p?.state ?? 'unknown'}
          size={240}
          stages={FLOW_STAGES}
          showLabels
          label={p && p.state !== 'quiet' && p.state !== 'unknown' ? FLOW_STAGES[p.at] : undefined}
          sublabel={p ? p.word : 'Unknown'}
          title={f && p ? `${f.name}: ${p.word}` : 'This flow: Unknown'}
        />
        <div className="flow-hero-text">
          <span className="overline">Run by your Supervisor</span>
          <strong className="flow-hero-name">{f ? f.name : flowKey}</strong>
          {!f ? (
            <p className="muted">
              {sup.honesty === 'loading'
                ? 'Checking this flow.'
                : s
                  ? 'The Supervisor does not list this flow.'
                  : 'This flow is Unknown until fwd answers.'}
            </p>
          ) : (
            <>
              <p className={`flow-hero-state is-${p?.state}`}>
                {p?.word} · {DIAL[f.dial]}
              </p>
              {f.reason && <p className="flow-hero-reason">{f.reason}</p>}
              {c && (
                <p className="small muted">
                  {c.total} drafted · {c.ready} to check · {c.sent + c.replied} sent · {c.replied} replied
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
