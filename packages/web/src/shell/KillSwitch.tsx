import { type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { api, UnreachableError } from '../api/client';
import { useLive } from '../api/live';
import { Button, macOnlyReason } from '../ui-kit/Button';
import { focusOnMount } from '../ui-kit/focus';
import { Copy } from '../ui-kit/honest';
import { Icon } from '../ui-kit/Icon';
import { usePrefs, useStill } from './prefs';

const HOLD_MS = 1500;

/** A modal built on <dialog>: focus trapping, Esc to close, inert background. */
export function Dialog({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    if (!d.open) d.showModal();
    const onCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    d.addEventListener('cancel', onCancel);
    return () => d.removeEventListener('cancel', onCancel);
  }, [onClose]);
  return (
    <dialog ref={ref} aria-label={label}>
      {children}
    </dialog>
  );
}

type Phase = 'ready' | 'holding' | 'cancelled' | 'armed' | 'sending' | 'failed' | 'unreachable';

/**
 * The kill switch state machine, shared by the top-bar pill and the big card.
 * Ready → Holding (1.5 s press, or hold Enter/Space) → Stopping (until fwd
 * confirms) → Stopped. Never says Stopped before fwd does.
 */
function useKillHold() {
  const { refreshStatus } = useLive();
  const [progress, setProgress] = useState(0); // 0..1 while holding
  const [phase, setPhase] = useState<Phase>('ready');
  const [failMsg, setFailMsg] = useState('');
  const startRef = useRef<number | null>(null);
  const raf = useRef<number | null>(null);
  const { status } = useLive();
  const k = status?.kill_switch.state;

  const fire = async () => {
    setPhase('sending');
    try {
      await api.kill();
      await refreshStatus();
      setPhase('ready');
    } catch (e) {
      if (e instanceof UnreachableError) setPhase('unreachable');
      else {
        setFailMsg((e as Error).message);
        setPhase('failed');
      }
    }
  };

  const begin = () => {
    if (phase === 'sending' || k === 'stopped' || k === 'stopping') return;
    startRef.current = performance.now();
    setPhase('holding');
    const step = () => {
      const p = Math.min(1, (performance.now() - (startRef.current ?? 0)) / HOLD_MS);
      setProgress(p);
      if (p >= 1) {
        startRef.current = null;
        fire();
        return;
      }
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  };
  /** Returns true when a hold was let go early. */
  const end = () => {
    if (raf.current) cancelAnimationFrame(raf.current);
    if (startRef.current !== null) {
      startRef.current = null;
      setProgress(0);
      setPhase('cancelled');
      return true;
    }
    return false;
  };
  // On unmount only stop the animation; there is no hold left to cancel.
  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    },
    [],
  );

  const holdHandlers = {
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      begin();
    },
    onPointerUp: end,
    onPointerCancel: end,
    onKeyDown: (e: KeyboardEvent) => {
      if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
        e.preventDefault();
        begin();
      }
    },
    onKeyUp: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') end();
    },
  };

  return { phase, setPhase, progress, failMsg, fire, end, holdHandlers };
}

function HoldRing({ size, progress }: { size: number; progress: number }) {
  const still = useStill();
  const r = size / 2 - 2.5;
  const circ = 2 * Math.PI * r;
  return (
    <svg className="hold-ring" width={size} height={size} aria-hidden="true">
      <circle className="track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth="2.5" />
      <circle
        className="fill"
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={still ? (progress > 0 ? 0 : circ) : circ * (1 - progress)}
      />
    </svg>
  );
}

/**
 * The compact Stop in the top bar. In hold mode it is a real kill switch (hold
 * 1.5 s); a short press, arm mode, or any state other than ready opens the
 * full kill switch dialog instead.
 */
export function KillPill({ onOpen }: { onOpen: () => void }) {
  const { status, connection } = useLive();
  const { prefs } = usePrefs();
  const { phase, progress, end, holdHandlers } = useKillHold();
  const k = status?.kill_switch.state;
  const common = {
    type: 'button' as const,
    'aria-haspopup': 'dialog' as const,
    'aria-keyshortcuts': 'Control+Shift+.',
  };

  if (connection === 'down') {
    return (
      <button {...common} className="kill-pill kill-pill-unreachable" onClick={onOpen}>
        <Icon name="terminal" /> <span className="nav-full">Stop:</span> fw kill
      </button>
    );
  }
  if (k === 'stopped' || k === 'stopping') {
    return (
      <button {...common} className={`kill-pill kill-pill-${k}`} onClick={onOpen}>
        <Icon name="stopped" /> {k === 'stopped' ? 'Stopped' : 'Stopping…'}
      </button>
    );
  }
  // On flowweb.app only the Mac can stop anything: never start a hold there, just open the kill switch.
  if (prefs.killMode === 'arm' || macOnlyReason()) {
    return (
      <button {...common} className="kill-pill" onClick={onOpen}>
        <Icon name="stopped" /> Stop
      </button>
    );
  }
  const holding = phase === 'holding';
  return (
    <button
      {...common}
      className={`kill-pill${holding || phase === 'sending' ? ' kill-pill-holding' : ''}`}
      disabled={phase === 'sending'}
      {...holdHandlers}
      onPointerUp={() => {
        if (end()) onOpen();
      }}
      onKeyUp={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && end()) onOpen();
      }}
      aria-label={holding ? 'Holding to stop everything' : 'Stop everything: press and hold'}
    >
      <HoldRing size={18} progress={progress} />
      <span aria-hidden="true">{phase === 'sending' ? 'Stopping…' : holding ? 'Holding…' : 'Stop'}</span>
    </button>
  );
}

/** The big kill switch card: dialog and Settings. */
export function KillControl() {
  const { status, connection } = useLive();
  const { prefs } = usePrefs();
  const { phase, setPhase, progress, failMsg, fire, holdHandlers } = useKillHold();
  const k = status?.kill_switch.state;

  if (connection === 'down' || phase === 'unreachable') {
    return (
      <section className="kill-card kill-card-unreachable" role="alert" aria-label="Kill switch">
        <div className="kill-head">
          <span className="icon-tile">
            <Icon name="wifi-off" size={20} />
          </span>
          <span>
            <strong className="kill-title">I could not reach fwd</strong>
            <span className="kill-body">Stop everything from a terminal on your machine:</span>
          </span>
        </div>
        <p className="row">
          <code className="command">fw kill</code> <Copy text="fw kill" label="the command fw kill" />
        </p>
      </section>
    );
  }

  if (k === 'stopping') {
    const s = status!.kill_switch;
    return (
      <section className="kill-card kill-card-stopped" role="status" aria-label="Kill switch">
        <div className="kill-head">
          <span className="icon-tile">
            <Icon name="stopped" size={20} />
          </span>
          <span>
            <strong className="kill-title">Stopping…</strong>
            <span className="kill-body">
              {s.runs_halted ?? 0} of {s.runs_to_halt ?? '?'} runs halted. Not stopped until fwd confirms.
            </span>
          </span>
        </div>
      </section>
    );
  }
  if (k === 'stopped') return <StoppedSummary />;
  if (macOnlyReason()) return <MacOnlyKill />;

  const hint =
    phase === 'holding'
      ? `Holding… ${((HOLD_MS * (1 - progress)) / 1000).toFixed(1)} s`
      : phase === 'cancelled'
        ? 'Not stopped. Hold for the full 1.5 seconds.'
        : phase === 'failed'
          ? `fwd refused: ${failMsg}`
          : prefs.killMode === 'arm'
            ? 'Press, then confirm.'
            : 'Press and hold for 1.5 seconds, or hold Enter.';

  const label = phase === 'sending' ? 'Sending stop to fwd' : 'Stop everything';

  const button =
    prefs.killMode === 'arm' ? (
      phase === 'armed' ? (
        <span className="row">
          <button type="button" className="kill-big" onClick={fire} ref={focusOnMount}>
            <Icon name="stopped" size={20} /> Confirm: stop everything
          </button>
          <button type="button" className="btn btn-big" onClick={() => setPhase('ready')}>
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="kill-big"
          onClick={() => setPhase('armed')}
          disabled={phase === 'sending'}
          aria-describedby="kill-hint"
        >
          <Icon name="stopped" size={20} /> {label}
        </button>
      )
    ) : (
      <button
        type="button"
        className="kill-big"
        disabled={phase === 'sending'}
        {...holdHandlers}
        aria-describedby="kill-hint"
      >
        <HoldRing size={26} progress={progress} />
        {label}
      </button>
    );

  return (
    <section className="kill-card" aria-label="Kill switch">
      <div className="kill-head">
        <span className="icon-tile">
          <Icon name="stopped" size={20} />
        </span>
        <span>
          <strong className="kill-title">Stop everything</strong>
          <span className="kill-body">
            Revokes agent access and halts every run. Work in progress stays saved.
          </span>
        </span>
      </div>
      <div>{button}</div>
      <p id="kill-hint" className="kill-hint" aria-live="polite">
        {hint}
      </p>
    </section>
  );
}

/**
 * The kill switch on flowweb.app. The site is a mirror; only fwd on the Owner's Mac can stop work,
 * so the button is locked with that reason and the terminal command is right there.
 */
function MacOnlyKill() {
  return (
    <section className="kill-card" aria-label="Kill switch">
      <div className="kill-head">
        <span className="icon-tile">
          <Icon name="stopped" size={20} />
        </span>
        <span>
          <strong className="kill-title">Stop everything</strong>
          <span className="kill-body">
            Revokes agent access and halts every run. FlowWeb runs on your Mac, so the stop is sent from
            there.
          </span>
        </span>
      </div>
      <div>
        <Button macOnly variant="stop">
          <Icon name="stopped" size={20} /> Stop everything
        </Button>
      </div>
      <p className="row kill-hint">
        In a terminal on your Mac: <code className="command">fw kill</code>{' '}
        <Copy text="fw kill" label="the command fw kill" />
      </p>
    </section>
  );
}

function StoppedSummary() {
  const { status } = useLive();
  const [release, setRelease] = useState(false);
  const k = status!.kill_switch;
  return (
    <section className="kill-card kill-card-stopped" role="status" aria-label="Kill switch">
      <div className="kill-head">
        <span className="icon-tile">
          <Icon name="stopped" size={20} />
        </span>
        <span>
          <strong className="kill-title">Everything is stopped</strong>
          <span className="kill-body">
            {k.runs_halted ?? 0} runs halted{k.keys_revoked ? ', agent keys revoked' : ''}.
          </span>
        </span>
      </div>
      <div>
        <Button macOnly onClick={() => setRelease(true)}>
          <Icon name="retry" /> Release…
        </Button>
      </div>
      {release && <ReleaseDialog onClose={() => setRelease(false)} />}
    </section>
  );
}

export function KillDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog label="Kill switch" onClose={onClose}>
      <h2>Kill switch</h2>
      <KillControl />
      <p className="dialog-actions">
        <button type="button" className="btn btn-quiet" onClick={onClose}>
          Close
        </button>
      </p>
    </Dialog>
  );
}

export function ReleaseDialog({ onClose }: { onClose: () => void }) {
  const { refreshStatus } = useLive();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Dialog label="Release the kill switch" onClose={onClose}>
      <h2>Restart work?</h2>
      <p>Runs stay paused until you start them. This is recorded.</p>
      {err && <p className="callout callout-warn">{err}</p>}
      <div className="row dialog-actions">
        <Button
          macOnly
          variant="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.release();
              await refreshStatus();
              onClose();
            } catch (e) {
              setErr(
                e instanceof UnreachableError
                  ? "Can't reach fwd. Nothing was released."
                  : (e as Error).message,
              );
              setBusy(false);
            }
          }}
        >
          Release
        </Button>
        <button type="button" className="btn" onClick={onClose}>
          Keep stopped
        </button>
      </div>
    </Dialog>
  );
}
