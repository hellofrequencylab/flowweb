// FW-C-099: the processes inside one flow, drawn as rings in the flow's hero. Every state comes from fwd's
// own reads (the Supervisor, the weekly review and the regions). When a read has not answered, its ring
// waits and says Unknown. It never shows a made-up state.
import type { ActivationTerritory, ReviewSummary, SupervisorFlow } from '../api/types';
import type { Loop, LoopInfo } from '../ui-kit/loop';
import { between, type OrbitProcess } from '../ui-kit/orbit';

const UNKNOWN = 'Unknown until fwd answers.';
const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;
/** Between cycles, the other parts of a working flow are hooked up but not working. */
const idle = (base: Loop): Loop => (base === 'working' ? 'connected' : base);

/** The lines around a ring. Each joins a node to the next, and the last closes the ring. */
function ringLinks(nodes: LoopInfo[], what: (from: string, to: string, last: boolean) => string): LoopInfo[] {
  return nodes.map((a, i) => {
    const b = nodes[(i + 1) % nodes.length];
    return {
      title: `${a.title} to ${b.title}`,
      loop: between(a.loop, b.loop),
      what: what(a.title, b.title, i === nodes.length - 1),
    };
  });
}

/** How the flow learns: outcomes come in, the week is scored, the plan shifts and the next brief carries it. */
export function learningRing(base: Loop | null, r: ReviewSummary | null): OrbitProcess {
  const state = r && ['none', 'thin', 'ready'].includes(r.state) ? r.state : null;
  const ready = state === 'ready';
  const brief: Loop =
    base === 'broken' ? 'broken' : ready ? (base === 'working' ? 'working' : 'connected') : 'waiting';
  const why = !state
    ? UNKNOWN
    : state === 'none'
      ? 'No outcomes yet. Nothing sent has been tracked.'
      : state === 'thin'
        ? `Fewer than ${r?.min_sent ?? 8} sent this week, so there is no call yet.`
        : `Scored ${r?.week ?? 'this week'}.`;
  const learnt = r?.learnings?.length ?? 0;
  const nodes: LoopInfo[] = [
    {
      title: 'Outcomes',
      loop: state && state !== 'none' ? 'connected' : 'waiting',
      what: 'Every day, Frequency sends back the clicks, sign-ups and replies from each draft.',
      why,
    },
    {
      title: 'Weekly score',
      loop: ready ? 'connected' : 'waiting',
      what: 'Once a week, the flow scores each hunt, source, region and angle by what it brought back.',
      why,
    },
    {
      title: 'Shift',
      loop: ready && learnt > 0 ? 'connected' : 'waiting',
      what: 'What works gets more of the next cycle. Your dial decides whether a shift waits for your OK.',
      why: ready ? `${learnt} learning${learnt === 1 ? '' : 's'} this week.` : why,
    },
    {
      title: 'Next brief',
      loop: brief,
      what: 'The next cycle starts from a brief that says what is working.',
      why: brief === 'working' ? 'A cycle is reading it now.' : why,
    },
  ];
  return {
    key: 'learning',
    summary: !state
      ? 'Unknown'
      : ready
        ? 'Scored this week'
        : state === 'thin'
          ? 'Not enough sent to score yet'
          : 'Waiting for outcomes',
    info: {
      title: 'Learning',
      loop: brief === 'broken' ? 'broken' : ready ? brief : 'waiting',
      what: 'How the flow gets better each week from what people did with its drafts.',
      why,
    },
    nodes,
    links: ringLinks(nodes, (a, b, last) =>
      last ? 'The brief shapes what the next cycle finds, and that brings new outcomes.' : `${a} feeds ${b}.`,
    ),
  };
}

/** The regions the flow works, one at a time. Upkeep keeps the finished ones active. */
export function regionRing(base: Loop | null, ts: ActivationTerritory[] | null): OrbitProcess | null {
  if (!ts || ts.length === 0) return null;
  const sorted = [...ts].sort((a, b) => a.order - b.order).slice(0, 8);
  const at = sorted.find((t) => t.status === 'active');
  const of = (t: ActivationTerritory): Loop =>
    !base || t.status === 'waiting' ? 'waiting' : t.status === 'upkeep' ? idle(base) : base;
  const nodes: LoopInfo[] = sorted.map((t, i) => ({
    title: t.name,
    loop: of(t),
    what: `Region ${i + 1} of ${sorted.length}. The flow works one region at a time and opens the next only with your OK.`,
    why:
      t.status === 'active'
        ? `Active now${t.progress != null ? `, ${pct(t.progress)} of the way to fully active` : ''}.`
        : t.status === 'upkeep'
          ? 'Fully active, and checked each week to keep it that way.'
          : 'Not opened yet.',
  }));
  return {
    key: 'regions',
    summary: at ? `Working ${at.name}` : 'No active region',
    info: {
      title: 'Regions',
      loop: base && at ? base : 'waiting',
      what: 'The places the flow works, in order. Upkeep checks the finished regions so they stay active.',
      why: !base ? UNKNOWN : at ? `${at.name} is active.` : 'No region is active yet.',
    },
    nodes,
    links: ringLinks(nodes, (a, b, last) =>
      last
        ? 'Upkeep: after the last region, the flow keeps every region active.'
        : `The flow moves on to ${b} once ${a} is fully active and you say OK.`,
    ),
  };
}

/** Spend against the flow's cap for the period, as a meter. It is broken at the cap or when there is no cap. */
export function spendRing(base: Loop | null, f: SupervisorFlow | null): OrbitProcess {
  const b = f?.budget ?? null;
  const spent = b?.spent_usd ?? null;
  const cap = b?.max_usd ?? null;
  const loop: Loop =
    !base || spent == null
      ? 'waiting'
      : cap == null || spent >= cap || f?.gate === 'budget' || f?.gate === 'cap_required'
        ? 'broken'
        : base === 'broken'
          ? 'connected'
          : base;
  const words =
    spent == null
      ? 'Unknown'
      : `${usd(spent)}${cap != null ? ` of ${usd(cap)}` : ', no cap'} this ${b?.period ?? 'period'}`;
  const turns =
    b?.used_turns != null && b.max_turns != null ? ` ${b.used_turns} of ${b.max_turns} turns.` : '';
  return {
    key: 'spend',
    summary: words,
    meter: spent != null && cap ? spent / cap : 0,
    info: {
      title: 'Spend',
      loop,
      what: 'What the flow spent on AI this period, against its cap. At the cap, the flow stops until the period ends.',
      why: spent == null ? UNKNOWN : `${words}.${turns}`,
    },
  };
}
