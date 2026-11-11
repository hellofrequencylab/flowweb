// FW-C-062: the Owner's flow controls on the Flows page. Turn each flow on or off, run it now, set its
// dial, and pause or resume the Supervisor. Locally fwd answers at once; on flowweb.app each change is
// queued and applied on the Owner's Mac by the relay, and the page says it is waiting. FW-C-063 adds the
// morning run time and how many new people a day, which Adjust from replies may move within min..max.
// FW-C-070 folds the Supervisor table in: each flow is one row, a group named after the flow, carrying its
// gate word, why, spend, on/off, Run now and dial.
import { useId, useState } from 'react';
import { ApiError, api } from '../api/client';
import { useResource } from '../api/resource';
import type { FlowIntensity, FlowSchedule, Supervisor, SupervisorDial, SupervisorFlow } from '../api/types';
import { HOSTED } from '../hosted/auth';
import { Button } from '../ui-kit/Button';
import { AsOf, ResourceView } from '../ui-kit/honest';
import { StatusLabel } from '../ui-kit/status';
import { usd } from '../ui-kit/time';
import { DIAL, flowSpec } from './flowState';

type Note = { tone: 'ok' | 'warn'; text: string } | null;

const STOPS: { stop: SupervisorDial; hint: string }[] = [
  { stop: 'draft', hint: 'Writes drafts. You copy and send each one.' },
  { stop: 'copilot', hint: 'You approve each draft; approved ones go to your sending app.' },
  { stop: 'autopilot', hint: 'Hands finished drafts to your sending app without asking.' },
];

/** FW-C-071: where the Owner sets up a sender, the one thing that reads the outbox. */
export const SENDER_STEPS =
  'https://github.com/hellofrequencylab/flowweb/blob/main/senders/README.md#set-up-once';
export const NEEDS_SENDER = 'Needs a sender on your Mac.';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One write at a time, with what happened (or that the Mac has not answered yet) shown below. */
function useWrite(reload: () => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);
  const run = async (label: string, fn: (queued: () => void) => Promise<unknown>, done: string) => {
    setBusy(label);
    setNote(null);
    let queued = false;
    try {
      await fn(() => {
        queued = true;
        setBusy(`${label} Waiting for your Mac to apply it.`);
      });
      setNote({ tone: 'ok', text: done });
      return true;
    } catch (e) {
      setNote({ tone: 'warn', text: message(e) });
      return false;
    } finally {
      setBusy(null);
      reload();
      // On the live site the page reads a copy the Mac refreshes right after a change.
      if (queued) window.setTimeout(reload, 8000);
    }
  };
  const shown = note && (
    <div className={`callout ${note.tone === 'ok' ? 'callout-ok' : 'callout-warn'}`} role="status">
      {note.text}
    </div>
  );
  return { busy, run, setNote, shown };
}

function budgetLine(f: SupervisorFlow): string {
  const b = f.budget;
  if (!b) return 'No spend cap';
  const spent = b.spent_usd == null ? 'Unknown' : usd(b.spent_usd);
  return b.max_usd == null ? `${spent} spent, no cap` : `${spent} of ${usd(b.max_usd)} this ${b.period}`;
}

const DAY_CHOICES = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays' },
] as const;

/** FW-C-063: when the flow runs each morning, and how many new people it reaches a day. */
function Tuning({ f, why, reload }: { f: SupervisorFlow; why: string | null; reload: () => void }) {
  const { busy, run, shown } = useWrite(reload);
  const sch: FlowSchedule | null = f.schedule ?? null;
  const cur: FlowIntensity | undefined = f.intensity;
  const [time, setTime] = useState(sch?.time ?? '07:00');
  const [days, setDays] = useState<'daily' | 'weekdays'>(sch?.days ?? 'weekdays');
  const [perDay, setPerDay] = useState(cur?.per_day ?? 10);
  const [auto, setAuto] = useState(cur?.auto ?? false);
  if (!sch && !cur) return null;
  const min = Math.min(cur?.min ?? 1, perDay);
  const max = Math.max(cur?.max ?? 25, perDay);
  const saveSchedule = () =>
    run(
      'Saving the schedule.',
      (q) => api.setSchedule(f.key, time, days, q),
      `${f.name} runs at ${time} ${days === 'daily' ? 'every day' : 'on weekdays'}.`,
    );
  const saveIntensity = () =>
    run(
      'Saving how many a day.',
      (q) => api.setIntensity(f.key, { per_day: perDay, auto, min, max }, q),
      auto
        ? `${f.name} aims for ${perDay} a day and adjusts from replies, between ${min} and ${max}.`
        : `${f.name} reaches up to ${perDay} new people a day.`,
    );
  const off = why ?? busy;
  return (
    <div className="stack">
      {sch && (
        <div className="row">
          <label className="row">
            <span>Runs at</span>
            <input
              type="time"
              aria-label={`Morning run time for ${f.name}`}
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </label>
          <select
            aria-label={`Days for ${f.name}`}
            value={days}
            onChange={(e) => setDays(e.target.value as typeof days)}
          >
            {DAY_CHOICES.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
          <Button onClick={saveSchedule} disabledReason={off} aria-label={`Save schedule for ${f.name}`}>
            Save time
          </Button>
          <span className="muted small">{sch.timezone}</span>
        </div>
      )}
      {cur && (
        <div className="stack">
          <div className="row">
            <label className="row">
              <span>New people a day: {perDay}</span>
              <input
                type="range"
                min={1}
                max={25}
                aria-label={`Leads per day for ${f.name}`}
                value={perDay}
                onChange={(e) => setPerDay(Number(e.target.value))}
              />
            </label>
            <label className="row">
              <input
                type="checkbox"
                aria-label={`Adjust from replies for ${f.name}`}
                checked={auto}
                onChange={(e) => setAuto(e.target.checked)}
              />
              <span>Adjust from replies</span>
            </label>
            <Button onClick={saveIntensity} disabledReason={off} aria-label={`Save intensity for ${f.name}`}>
              Save
            </Button>
          </div>
          <p className="muted small">
            {cur.today.per_day} today. {cur.today.why} The weekly cap and each hunt's cap still apply.
          </p>
        </div>
      )}
      {busy && <p className="muted small">{busy}</p>}
      {shown}
    </div>
  );
}

/** A fieldset holds one flow's row so it reads as a group named after the flow, inside the list. */
const ROW = {
  border: 0,
  padding: 0,
  margin: 0,
  minWidth: 0,
  display: 'grid',
  gap: 'var(--space-4)',
} as const;

function FlowRow({
  f,
  stopped,
  sender,
  reload,
}: {
  f: SupervisorFlow;
  stopped: boolean;
  /** FW-C-071: a sender on the Mac read the outbox in the last day. */
  sender: boolean;
  reload: () => void;
}) {
  const { busy, run, setNote, shown } = useWrite(reload);
  const [confirm, setConfirm] = useState<string | null>(null);
  const group = useId();
  const toggle = () =>
    run(
      f.enabled ? 'Turning it off.' : 'Turning it on.',
      (q) => api.flowControl(f.key, f.enabled ? 'disable' : 'enable', q),
      f.enabled ? `${f.name} is off.` : `${f.name} is on. It runs on its schedule.`,
    );
  const runNow = () =>
    run('Starting a cycle.', (q) => api.flowControl(f.key, 'run', q), `${f.name} was asked to run now.`);
  const dial = async (stop: SupervisorDial, hash?: string) => {
    if (stop === f.dial && !hash) return;
    if (stop === 'autopilot' && HOSTED) {
      setNote({
        tone: 'warn',
        text: `Autopilot is set on your Mac: pnpm fw supervisor dial ${f.key} autopilot`,
      });
      return;
    }
    setConfirm(null);
    await run('Moving the dial.', (q) => api.setDial(f.key, stop, hash, q), `${f.name} is at ${DIAL[stop]}.`);
  };
  // Autopilot asks fwd first: a 409 carries the hash that binds the choice to this flow's channels and caps.
  const askAutopilot = async () => {
    if (HOSTED) return dial('autopilot');
    try {
      await api.setDial(f.key, 'autopilot');
      reload();
    } catch (e) {
      const hash = e instanceof ApiError ? (e.details as { confirm_hash?: string })?.confirm_hash : undefined;
      if (hash) setConfirm(hash);
      else setNote({ tone: 'warn', text: message(e) });
    }
  };
  const why = busy ?? (stopped ? 'The kill switch is engaged.' : null);
  const name = useId();
  return (
    <li>
      <fieldset
        aria-labelledby={name}
        style={ROW}
        className={f.state === 'running' ? 'is-live live-edge' : undefined}
      >
        <div className="panel-head">
          <strong id={name}>{f.name}</strong>
          <StatusLabel spec={flowSpec(f)} />
        </div>
        <p className="muted small">
          {f.reason} · {budgetLine(f)}
        </p>
        <div className="row">
          <Button
            variant={f.enabled ? 'quiet' : 'primary'}
            onClick={toggle}
            disabledReason={why}
            aria-label={`${f.enabled ? 'Turn off' : 'Turn on'} ${f.name}`}
          >
            {f.enabled ? 'Turn off' : 'Turn on'}
          </Button>
          <Button
            onClick={runNow}
            disabledReason={why ?? (f.enabled ? null : 'Turn it on first.')}
            aria-label={`Run ${f.name} now`}
          >
            Run now
          </Button>
        </div>
        <div role="radiogroup" aria-label={`Dial for ${f.name}`} className="stack">
          {STOPS.map(({ stop, hint }) => {
            const noSender = stop !== 'draft' && !sender;
            return (
              <label key={stop} className="row">
                <input
                  type="radio"
                  name={group}
                  value={stop}
                  checked={f.dial === stop}
                  disabled={Boolean(why) || noSender}
                  onChange={() => (stop === 'autopilot' ? askAutopilot() : dial(stop))}
                />
                <span>
                  <strong>{DIAL[stop]}</strong>{' '}
                  <span className="muted small">{noSender ? NEEDS_SENDER : hint}</span>
                </span>
              </label>
            );
          })}
        </div>
        {!sender && (
          <p className="muted small">
            Copilot and Autopilot hand drafts to a sender on your Mac, and none has run there in the last day.
            Until one does, copy each draft and send it from your own mail.{' '}
            <a href={SENDER_STEPS} target="_blank" rel="noreferrer">
              How to set up a sender
            </a>
          </p>
        )}
        <Tuning f={f} why={why} reload={reload} />
        {confirm && (
          <div className="callout callout-attention stack">
            <p>
              Put {f.name} on Autopilot? It hands each finished draft to your sending app without asking you,
              using only this flow's channels and caps. FlowWeb itself still never sends. The kill switch and
              the stall breaker stay on.
            </p>
            <div className="row">
              <Button variant="primary" onClick={() => dial('autopilot', confirm)} disabledReason={busy}>
                Yes, Autopilot
              </Button>
              <Button variant="quiet" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {busy && <p className="muted small">{busy}</p>}
        {shown}
      </fieldset>
    </li>
  );
}

/** The flows as rows. Pure apart from writes, so it can be tested without fwd. */
export function Controls({ s, reload }: { s: Supervisor; reload: () => void }) {
  const { busy, run, shown } = useWrite(reload);
  const pause = () =>
    run(
      s.paused ? 'Resuming.' : 'Pausing.',
      (q) => api.setSupervisorPaused(!s.paused, q),
      s.paused ? 'Flows run again on their schedules.' : 'Paused. No flow starts until you resume.',
    );
  return (
    <div className="stack">
      <div className="row">
        <p>
          {s.kill_switch
            ? 'The kill switch is engaged. Nothing runs until you release it.'
            : s.paused
              ? 'Paused: no flow starts until you resume.'
              : `Runs up to ${s.max_concurrent} at once; ${s.running} running now.`}
        </p>
        <Button variant={s.paused ? 'primary' : 'quiet'} onClick={pause} disabledReason={busy}>
          {s.paused ? 'Resume all flows' : 'Pause all flows'}
        </Button>
      </div>
      {busy && <p className="muted small">{busy}</p>}
      {shown}
      <ul className="plain-list stack" aria-label="Flows">
        {s.flows.map((f) => (
          <FlowRow
            key={f.key}
            f={f}
            stopped={s.kill_switch}
            sender={s.sender?.installed === true}
            reload={reload}
          />
        ))}
      </ul>
      {HOSTED && (
        <p className="muted small">
          Changes here are applied on your Mac, usually within a few seconds while FlowWeb runs there.
        </p>
      )}
    </div>
  );
}

/** The controls panel: every flow the Supervisor runs, with its gate word, switch, Run now and dial. */
export function FlowControls() {
  const id = useId();
  const res = useResource('supervisor', () => api.supervisor(), ['runs', 'cards']);
  return (
    <section className="panel stack" aria-labelledby={id}>
      <div className="panel-head">
        <h2 id={id}>Controls</h2>
        <span className="asof">
          <AsOf res={res} />
        </span>
      </div>
      <ResourceView res={res} what="the flow controls">
        {(s) => <Controls s={s} reload={res.reload} />}
      </ResourceView>
    </section>
  );
}
