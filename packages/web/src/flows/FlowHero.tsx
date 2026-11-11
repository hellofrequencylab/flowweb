import { api } from '../api/client';
import { useResource } from '../api/resource';
import { Link } from '../shell/router';
import { FlowRing, hueAt } from '../ui-kit/flow';
import { Icon } from '../ui-kit/Icon';
import type { Loop, LoopInfo } from '../ui-kit/loop';
import { type Counts, draftCounts, FLOW_STAGES, positionOf } from './FlowsHome';
import { DIAL, flowLoop } from './flowState';
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
  // FW-C-097: motion only while fwd says a cycle is running now; idle stays still.
  const live = p?.state === 'running';
  return (
    <section className={`flow-hero${live ? ' is-live' : ''}`} aria-label="Where this flow is">
      <Link to="/" className="flow-hero-back">
        <Icon name="arrow-left" size={16} /> All flows
      </Link>
      <div className={`flow-hero-body${live ? ' live-edge' : ''}`}>
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
          {...(f ? stageLoops(flowLoop(f), c, f.reason) : {})}
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
                {live && <span className="flow-pulse-dot" aria-hidden="true" />}
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

/** What each stage of a flow is, in the order of FLOW_STAGES. */
const STAGE_WHAT = [
  'The agent searches public event listings in your regions for organizers to invite.',
  'Each find becomes a short, personal draft with your link.',
  'Drafts wait here for you to read, edit and send. Nothing goes out on its own.',
  'Drafts you copied and sent yourself, marked as sent.',
  'Organizers who wrote back. What gets replies teaches the next cycle.',
];

/**
 * FW-C-098: each stage's loop state and the line to the next one, from the flow's state and its draft
 * counts. A running cycle lights Find and Draft; drafts waiting on you hold You check; Sent and Replies
 * wait until something has been sent or answered. Every line carries the flow's own state, so a healthy loop flows all the way round.
 */
function stageLoops(base: Loop, c: Counts | null, reason: string): { loops: LoopInfo[]; links: LoopInfo[] } {
  const idle = base === 'working' ? 'connected' : base;
  const has = (n: number | undefined): Loop => (base === 'broken' ? 'broken' : n ? idle : 'waiting');
  const states: Loop[] = [
    base,
    base,
    c && c.ready > 0 ? 'waiting' : idle,
    has(c ? c.sent + c.replied : 0),
    has(c?.replied),
  ];
  const counts = c
    ? [
        undefined,
        `${c.total} drafted so far.`,
        `${c.ready} ready for you.`,
        `${c.sent + c.replied} sent.`,
        `${c.replied} replied.`,
      ]
    : [];
  const loops = FLOW_STAGES.map((title, i) => ({
    title,
    loop: states[i],
    what: STAGE_WHAT[i],
    why: [counts[i], i < 2 ? reason : undefined].filter(Boolean).join(' ') || undefined,
  }));
  const links = FLOW_STAGES.map((from, i) => {
    const to = FLOW_STAGES[(i + 1) % FLOW_STAGES.length];
    return {
      title: `${from} to ${to}`,
      // The loop is as healthy as the flow: a running cycle lights the leg it is on, the rest flow slowly.
      loop: base === 'working' && i > 0 ? 'connected' : base,
      what:
        i === FLOW_STAGES.length - 1
          ? 'Replies feed back into the next search, which closes the loop.'
          : `How work moves from ${from} to ${to}.`,
    } satisfies LoopInfo;
  });
  return { loops, links };
}
