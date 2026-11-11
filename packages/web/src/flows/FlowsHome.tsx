import type { CSSProperties } from 'react';
import { api } from '../api/client';
import { useLive, useStatusResource } from '../api/live';
import { type Resource, useResource } from '../api/resource';
import type { Envelope, Supervisor, SupervisorFlow } from '../api/types';
import { Problems } from '../dawn/DawnLog';
import { RegionProgress } from '../dawn/Today';
import { Link } from '../shell/router';
import { FlowLine, FlowRing, type FlowState, type Hue, hueAt, StageHeader } from '../ui-kit/flow';
import { Icon } from '../ui-kit/Icon';
import { Figures, PageHead, SectionHead } from '../ui-kit/page';
import { clock, useNow } from '../ui-kit/time';
import { stateOf } from './drafts';
import { DIAL, flowSpec } from './flowState';
import { liveFlows } from './visible';
import './flows-home.css';

/** Every flow moves through the same five stages. Nothing is sent by FlowWeb: "Sent" is the Owner's send. */
export const FLOW_STAGES = ['Find', 'Draft', 'You check', 'Sent', 'Replies'] as const;

/** Where one flow is worked: its own page. */
export const flowHref = (key: string) => `/flows/${encodeURIComponent(key)}`;

export type Counts = { ready: number; blanks: number; sent: number; replied: number; total: number };
export type DraftCounts = Envelope & { byFlow: Record<string, Counts | null> };

/** Drafts per flow, counted by state. A flow whose drafts fwd did not answer for is null, never zero. */
export async function draftCounts(): Promise<DraftCounts> {
  const s = await api.supervisor().then((s) => ({ ...s, flows: liveFlows(s.flows) }));
  const byFlow: Record<string, Counts | null> = {};
  const asOf: string[] = [s.data_as_of];
  await Promise.all(
    s.flows.map(async (f) => {
      try {
        const l = await api.flowDrafts(f.key);
        asOf.push(l.data_as_of);
        const c: Counts = { ready: 0, blanks: 0, sent: 0, replied: 0, total: l.drafts.length };
        for (const d of l.drafts) {
          const st = stateOf(d);
          if (st === 'Ready') c.ready++;
          else if (st === 'Has blanks') c.blanks++;
          else if (st === 'Sent') c.sent++;
          else if (st === 'Replied' || st === 'Said no') c.replied++;
        }
        byFlow[f.key] = c;
      } catch {
        byFlow[f.key] = null;
      }
    }),
  );
  return { data_as_of: asOf.sort()[0], byFlow };
}

export interface Position {
  at: number;
  state: FlowState;
  word: string;
}

/**
 * Where a flow is on its five stages, from what fwd reported and nothing else. A running cycle finds and
 * drafts; ready drafts wait at You check; a held flow stays still and names its gate.
 */
export function positionOf(f: SupervisorFlow, c: Counts | null | undefined): Position {
  if (f.gate === 'kill_switch' || f.gate === 'supervisor_paused')
    return { at: 0, state: 'paused', word: flowSpec(f).word };
  if (f.state === 'running') return { at: 1, state: 'running', word: 'Working' };
  if (c && c.ready > 0) return { at: 2, state: 'waiting', word: `${c.ready} to check` };
  if (f.gate === 'open_asks') return { at: 2, state: 'waiting', word: 'Needs your answers' };
  if (!f.enabled) return { at: 0, state: 'quiet', word: 'Off' };
  const at = !c ? 0 : c.replied > 0 ? 4 : c.sent > 0 ? 3 : c.total > 0 ? 2 : 0;
  return { at, state: at === 0 ? 'quiet' : 'held', word: flowSpec(f).word };
}

const hueOf = (i: number): Hue => hueAt(i);
/** fwd sends null for a cap that is not set: never crash on it. */
const money = (n: number | null | undefined) =>
  typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : null;
const unknown = <span className="fact-unknown">Unknown</span>;

function greeting(now: number) {
  const h = new Date(now).getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/** What the Supervisor is doing, in one word. */
function supervisorWord(s: Supervisor | null): { word: string; tone: string } {
  if (!s) return { word: 'Unknown', tone: 'unknown' };
  if (s.kill_switch) return { word: 'Stopped', tone: 'stop' };
  if (s.paused) return { word: 'Paused', tone: 'paused' };
  if (s.running > 0) return { word: 'Working', tone: 'running' };
  return { word: 'Resting', tone: 'quiet' };
}

/**
 * Home. One Supervisor runs every flow for you: this page shows it at the centre, each flow around it,
 * what waits on you, and where every flow stands. Anything fwd did not answer reads Unknown, never zero.
 */
export function FlowsHome() {
  const sup = useResource(
    'supervisor',
    () => api.supervisor().then((s) => ({ ...s, flows: liveFlows(s.flows) })),
    ['runs', 'cards'],
  );
  const counts = useResource('home:drafts', draftCounts, ['runs', 'cards']);
  const act = useResource('flow:neighborhood-activation', () => api.activationFlow(), ['runs', 'cards']);
  const st = useStatusResource();
  const { connection } = useLive();
  const now = useNow();
  const s = sup.honesty === 'current' ? sup.data : null;
  const c = counts.honesty === 'current' ? counts.data : null;
  const status = st.honesty === 'current' ? st.data : null;
  const ready = c
    ? Object.values(c.byFlow).reduce((n, x) => (x && n != null ? n + x.ready : null), 0 as number | null)
    : null;
  const sw = supervisorWord(s);

  return (
    <div className="flows-home">
      <PageHead
        script={greeting(now)}
        title={s && s.running > 0 ? 'Your flows are working.' : 'Your flows'}
        lede="One Supervisor runs every flow for you. It finds people, drafts the notes, and brings you only what needs your eye."
        aside={
          <Figures
            label="Right now"
            items={[
              { label: 'running now', value: s ? s.running : unknown, tone: 'active' },
              { label: 'drafts to check', value: ready ?? unknown, tone: ready ? 'waiting' : undefined },
              {
                label: 'decisions waiting',
                value: status ? status.cards_open : unknown,
                tone: status?.cards_open ? 'waiting' : undefined,
              },
              {
                label: 'spent today',
                value: money(status?.spend_today?.usd) ?? unknown,
                of: money(status?.spend_today?.cap_usd)
                  ? `of ${money(status?.spend_today?.cap_usd)}`
                  : undefined,
              },
            ]}
          />
        }
      />
      <Problems status={st.data} down={connection === 'down'} />
      <NeedsYou drafts={ready} cards={status ? status.cards_open : null} asOf={c?.data_as_of ?? null} />

      <section className="flows-home-section" aria-labelledby="sup-title">
        <SectionHead
          id="sup-title"
          overline={
            s
              ? `${s.flows.length} flow${s.flows.length === 1 ? '' : 's'} · up to ${s.max_concurrent} at once`
              : 'Supervisor'
          }
          title="Your Supervisor"
          meta={sup.asOf ? `updated ${clock(sup.asOf)}` : undefined}
        />
        <SupervisorMap res={sup} counts={c} word={sw} />
      </section>

      <section className="flows-home-section" aria-labelledby="every-flow">
        <SectionHead id="every-flow" title="Every flow" meta="Open a flow to tune it" />
        <EveryFlow sup={s} counts={c} loading={sup.honesty === 'loading'} />
      </section>

      <section className="flows-home-section" aria-label="What the flows are moving">
        <SectionHead title="What they are moving" />
        <RegionProgress res={act} />
      </section>
    </div>
  );
}

/** The one saffron moment: what waits on you. Shown quietly, without saffron, when nothing does. */
function NeedsYou({
  drafts,
  cards,
  asOf,
}: {
  drafts: number | null;
  cards: number | null;
  asOf: string | null;
}) {
  const n = drafts != null && cards != null ? drafts + cards : null;
  if (n == null)
    return (
      <div className="needs-strip needs-strip-unknown">
        <span className="needs-strip-label muted">What needs you is Unknown until fwd answers.</span>
      </div>
    );
  if (n === 0)
    return (
      <div className="needs-strip needs-strip-clear">
        <Icon name="verified" size={18} />
        <span className="needs-strip-label">
          Nothing needs you. <span className="muted">Checked {clock(asOf)}.</span>
        </span>
      </div>
    );
  return (
    <section className="needs-strip" aria-label="Needs you">
      <span className="needs-strip-mark" aria-hidden="true">
        <Icon name="waiting" size={18} />
      </span>
      <span className="needs-strip-label">{n} need you</span>
      <span className="flows-home-chips">
        {(drafts ?? 0) > 0 && (
          <Link to="/inbox" className="flows-home-chip">
            <Icon name="send" size={14} /> {drafts} draft{drafts === 1 ? '' : 's'} ready to send
          </Link>
        )}
        {(cards ?? 0) > 0 && (
          <Link to="/inbox" className="flows-home-chip">
            <Icon name="signoffs" size={14} /> {cards} decision{cards === 1 ? '' : 's'} waiting
          </Link>
        )}
      </span>
      <Link to="/inbox" className="btn btn-primary">
        Review all
      </Link>
    </section>
  );
}

/** Where each node sits beside the hub, as a share of the map's width and height: left column, then right. */
function spot(i: number, n: number): [number, number] {
  const left = Math.ceil(n / 2);
  const col = i < left ? 0 : 1;
  const k = col === 0 ? i : i - left;
  const m = col === 0 ? left : n - left;
  const y = m === 1 ? 50 : 22 + (56 * k) / (m - 1);
  return [col === 0 ? 17 : 83, y];
}

/**
 * The Supervisor at the centre with each flow around it. A line lights and carries a spark only while
 * that flow is actually running; idle stays still. On a phone the map becomes a column.
 */
function SupervisorMap({
  res,
  counts,
  word,
}: {
  res: Resource<Supervisor>;
  counts: DraftCounts | null;
  word: { word: string; tone: string };
}) {
  const s = res.data;
  const stale = res.honesty !== 'current';
  if (!s)
    return (
      <p className="small muted">
        {res.honesty === 'loading'
          ? 'Checking the Supervisor.'
          : 'The Supervisor is Unknown until fwd answers.'}
      </p>
    );
  const nodes = [...s.flows.map((f) => f.key), '+'];
  const slots = Math.max(1, s.max_concurrent);
  return (
    <div className={`sup-map${stale ? ' is-stale' : ''}`}>
      <svg className="sup-map-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {nodes.map((k, i) => {
          const [x, y] = spot(i, nodes.length);
          const f = s.flows.find((x) => x.key === k);
          const live = !stale && f?.state === 'running';
          return (
            <g key={k} className={live ? 'is-live' : k === '+' ? 'is-ghost' : undefined}>
              <line
                x1="50"
                y1="50"
                x2={x}
                y2={y}
                className="sup-map-line"
                vectorEffect="non-scaling-stroke"
              />
              {live && (
                <line
                  x1="50"
                  y1="50"
                  x2={x}
                  y2={y}
                  className="fw-motion sup-map-spark"
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </g>
          );
        })}
      </svg>
      <fieldset
        className={`sup-hub is-${word.tone}`}
        aria-label={`Supervisor: ${word.word}, ${s.running} of ${slots} running`}
      >
        <svg className="sup-hub-slots" viewBox="0 0 100 100" aria-hidden="true">
          {Array.from({ length: slots }, (_, i) => {
            const a = ((-90 + (360 * i) / slots) * Math.PI) / 180;
            return (
              <circle
                key={String(i)}
                cx={50 + 46 * Math.cos(a)}
                cy={50 + 46 * Math.sin(a)}
                r="3.4"
                className={i < s.running && !stale ? 'is-on' : undefined}
              />
            );
          })}
        </svg>
        <span className="sup-hub-core">
          <Icon name="sparkles" size={22} />
          <strong>Supervisor</strong>
          <span className="sup-hub-word">{stale ? 'Unknown' : word.word}</span>
          <span className="sup-hub-sub">
            {stale ? 'Last known' : ''} {s.running} of {slots} running
          </span>
        </span>
      </fieldset>
      <ul className="sup-map-nodes" aria-label="Flows the Supervisor runs">
        {nodes.map((k, i) => {
          const [x, y] = spot(i, nodes.length);
          const style = { '--x': `${x}%`, '--y': `${y}%` } as CSSProperties;
          if (k === '+')
            return (
              <li key="+" className="sup-node is-add" style={style}>
                <Link to="/start" className="sup-node-link">
                  <span className="sup-node-add" aria-hidden="true">
                    +
                  </span>
                  <span className="sup-node-name">Add a flow</span>
                  <span className="sup-node-meta">The Supervisor runs it with the rest</span>
                </Link>
              </li>
            );
          const fi = s.flows.findIndex((x) => x.key === k);
          const f = s.flows[fi];
          const p = stale
            ? { at: 0, state: 'unknown' as const, word: 'Unknown' }
            : positionOf(f, counts?.byFlow[k]);
          return (
            <li key={k} className={`sup-node is-${p.state}`} style={style}>
              <Link to={flowHref(k)} className="sup-node-link">
                <FlowRing hue={hueOf(fi)} at={p.at} state={p.state} size={76} stages={FLOW_STAGES} title="" />
                <span className="sup-node-name">{f.name}</span>
                <span className="sup-node-meta">
                  {p.word} · {DIAL[f.dial]}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Each flow as a line through its five stages, with the reason it is where it is. */
function EveryFlow({
  sup,
  counts,
  loading,
}: {
  sup: Supervisor | null;
  counts: DraftCounts | null;
  loading: boolean;
}) {
  if (!sup)
    return (
      <p className="small muted">
        {loading ? 'Checking the flows.' : 'Flow states are Unknown until fwd answers.'}
      </p>
    );
  if (sup.flows.length === 0)
    return (
      <p className="small muted">
        No flows yet. <Link to="/setup">Add your first flow</Link>.
      </p>
    );
  return (
    <div className="flow-map flows-home-map">
      <StageHeader stages={FLOW_STAGES} />
      <ul className="flows-home-lines" aria-label="Flows">
        {sup.flows.map((f, i) => {
          const c = counts?.byFlow[f.key];
          const p = positionOf(f, c);
          return (
            <li key={f.key}>
              <FlowLine
                name={f.name}
                meta={f.reason || undefined}
                hue={hueOf(i)}
                at={p.at}
                state={p.state}
                word={p.word}
                stages={FLOW_STAGES}
                when={c ? `${c.sent} sent · ${c.replied} replied` : undefined}
                to={flowHref(f.key)}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
