import { type ReactNode, useEffect, useRef, useState } from 'react';
import { api, UnreachableError } from '../api/client';
import { useLive } from '../api/live';
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

/**
 * The kill switch. Ready → Holding (1.5 s press, or hold Enter/Space) → Stopping
 * (until fwd confirms) → Stopped. "Arm then confirm" replaces holding when the
 * Owner prefers it. Never says Stopped before fwd does.
 */
export function KillControl({ big = false }: { big?: boolean }) {
  const { status, connection, refreshStatus } = useLive();
  const { prefs } = usePrefs();
  const still = useStill();
  const [progress, setProgress] = useState(0); // 0..1 while holding
  const [phase, setPhase] = useState<
    'ready' | 'holding' | 'cancelled' | 'armed' | 'sending' | 'failed' | 'unreachable'
  >('ready');
  const [failMsg, setFailMsg] = useState('');
  const startRef = useRef<number | null>(null);
  const raf = useRef<number | null>(null);
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
  const end = () => {
    if (raf.current) cancelAnimationFrame(raf.current);
    if (startRef.current !== null) {
      startRef.current = null;
      setProgress(0);
      setPhase('cancelled');
    }
  };
  // On unmount only stop the animation; there is no hold left to cancel.
  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    },
    [],
  );

  if (connection === 'down' || phase === 'unreachable') {
    return (
      <div className="stack" role="alert">
        <p>
          <strong>I could not reach fwd.</strong> Stop from a terminal:
        </p>
        <p className="row">
          <code>fw kill</code> <Copy text="fw kill" label="the command fw kill" />
        </p>
      </div>
    );
  }

  if (k === 'stopping') {
    const s = status!.kill_switch;
    return (
      <p role="status">
        <strong>Stopping…</strong> {s.runs_halted ?? 0} of {s.runs_to_halt ?? '?'} runs halted.
      </p>
    );
  }
  if (k === 'stopped') {
    return <StoppedSummary />;
  }

  const ringSize = big ? 28 : 20;
  const r = ringSize / 2 - 3;
  const circ = 2 * Math.PI * r;
  const label = phase === 'sending' ? 'Sending stop to fwd' : 'Stop everything';

  const button =
    prefs.killMode === 'arm' ? (
      phase === 'armed' ? (
        <span className="row">
          <button type="button" className="btn btn-stop" onClick={fire} ref={focusOnMount}>
            Confirm: stop everything
          </button>
          <button type="button" className="btn" onClick={() => setPhase('ready')}>
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="btn btn-stop"
          onClick={() => setPhase('armed')}
          disabled={phase === 'sending'}
        >
          <Icon name="stopped" /> {label}
        </button>
      )
    ) : (
      <button
        type="button"
        className="btn btn-stop"
        disabled={phase === 'sending'}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          begin();
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
            e.preventDefault();
            begin();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === 'Enter' || e.key === ' ') end();
        }}
        aria-describedby="kill-hint"
      >
        <svg className="hold-ring" width={ringSize} height={ringSize} aria-hidden="true">
          <circle className="track" cx={ringSize / 2} cy={ringSize / 2} r={r} fill="none" strokeWidth="3" />
          <circle
            className="fill"
            cx={ringSize / 2}
            cy={ringSize / 2}
            r={r}
            fill="none"
            strokeWidth="3"
            strokeDasharray={circ}
            strokeDashoffset={still ? (progress > 0 ? 0 : circ) : circ * (1 - progress)}
          />
        </svg>
        {label}
      </button>
    );

  return (
    <div className="stack">
      {button}
      <p id="kill-hint" className="small" aria-live="polite">
        {phase === 'holding' && `Holding… ${((HOLD_MS * (1 - progress)) / 1000).toFixed(1)} s`}
        {phase === 'cancelled' && 'Not stopped. Hold for the full 1.5 seconds.'}
        {phase === 'failed' && `fwd refused: ${failMsg}`}
        {(phase === 'ready' || phase === 'sending' || phase === 'armed') &&
          (prefs.killMode === 'arm'
            ? 'Revokes agent access and halts every run. Work in progress stays saved.'
            : 'Press and hold for 1.5 seconds, or hold Enter. Revokes agent access and halts every run. Work in progress stays saved.')}
      </p>
    </div>
  );
}

function StoppedSummary() {
  const { status } = useLive();
  const [release, setRelease] = useState(false);
  const k = status!.kill_switch;
  return (
    <div className="stack" role="status">
      <p>
        <strong>Everything is stopped.</strong> {k.runs_halted ?? 0} runs halted
        {k.keys_revoked ? ', agent keys revoked' : ''}.
      </p>
      <button type="button" className="btn" onClick={() => setRelease(true)}>
        Release…
      </button>
      {release && <ReleaseDialog onClose={() => setRelease(false)} />}
    </div>
  );
}

export function KillDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog label="Kill switch" onClose={onClose}>
      <h2>Kill switch</h2>
      <KillControl big />
      <p>
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
      <div className="row">
        <button
          type="button"
          className="btn btn-primary"
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
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Keep stopped
        </button>
      </div>
    </Dialog>
  );
}
