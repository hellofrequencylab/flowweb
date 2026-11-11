import {
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Icon } from './Icon';

/**
 * FW-C-098: one look for every meter, node and line of a flow, from what fwd reported.
 * - working: a cycle is running through it now. Full brightness, fast flow.
 * - connected: hooked up and healthy between cycles. Dimmer, slow flow.
 * - waiting: not in use yet, or waiting for a cycle or for you. Still, with a soft pulse.
 * - broken: missing a piece or stopped by a problem. Warning tones, no motion.
 * Reduced motion and calm mode stop the motion; brightness, colour and the words still differ.
 */
export type Loop = 'working' | 'connected' | 'waiting' | 'broken';

export const LOOP_WORD: Record<Loop, string> = {
  working: 'Working now',
  connected: 'Connected',
  waiting: 'Waiting',
  broken: 'Needs attention',
};

/** What a person sees when they click a node, a line or a meter. */
export interface LoopInfo {
  title: string;
  loop: Loop;
  /** What this piece is, in one sentence. */
  what: string;
  /** Why it is in this state, when fwd said. */
  why?: string;
}

type Pick = (info: LoopInfo | null) => void;
const Ctx = createContext<{ picked: LoopInfo | null; pick: Pick } | null>(null);

/** Holds the one piece being explained and shows it in a small panel. */
export function LoopProvider({ children }: { children: ReactNode }) {
  const [picked, setPicked] = useState<LoopInfo | null>(null);
  const pick = useCallback<Pick>((i) => setPicked(i), []);
  const value = useMemo(() => ({ picked, pick }), [picked, pick]);
  useEffect(() => {
    if (!picked) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setPicked(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picked]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {picked && (
        <aside className={`loop-panel loop-${picked.loop}`} aria-live="polite" aria-label={picked.title}>
          <div className="loop-panel-head">
            <span className="loop-dot" aria-hidden="true" />
            <strong>{picked.title}</strong>
            <span className="loop-panel-state">{LOOP_WORD[picked.loop]}</span>
            <button
              type="button"
              className="loop-panel-close"
              aria-label="Close"
              onClick={() => setPicked(null)}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
          <p>{picked.what}</p>
          {picked.why && <p className="muted small">{picked.why}</p>}
        </aside>
      )}
    </Ctx.Provider>
  );
}

/**
 * Props that make any element (an HTML element or an SVG group) a clickable piece of the loop.
 * Outside a LoopProvider it only carries the state class.
 */
export function useLoopTarget() {
  const ctx = useContext(Ctx);
  return useCallback(
    (info: LoopInfo, extra = '') => {
      const className = `loop-target loop-${info.loop}${extra ? ` ${extra}` : ''}`;
      if (!ctx) return { className };
      const open = () => ctx.pick(info);
      return {
        className,
        role: 'button',
        tabIndex: 0,
        'aria-label': `${info.title}: ${LOOP_WORD[info.loop]}. Show what this is.`,
        'aria-pressed': ctx.picked?.title === info.title,
        onClick: open,
        onKeyDown: (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          }
        },
      };
    },
    [ctx],
  );
}
