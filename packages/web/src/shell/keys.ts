import { useEffect, useRef } from 'react';

/** Set when "g" was pressed, so screen shortcuts yield to "g then x" navigation. */
export const chord = { gAt: 0 };
export const chordPending = () => Date.now() - chord.gAt < 1200;

/** Keys are KeyboardEvent.key values; named keys in lower case (enter, escape). */
export type KeyMap = Record<string, (e: KeyboardEvent) => void>;

function typing(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

/**
 * Single-key shortcuts. Ignored while typing, with modifiers (except the
 * explicit "mod+shift+." combo), or when `enabled` is false.
 */
export function useKeys(map: KeyMap, enabled = true) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    const on = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === '.' || e.key === '>')) {
        const fn = ref.current['mod+shift+.'];
        if (fn) {
          e.preventDefault();
          fn(e);
        }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
      if (document.querySelector('dialog[open]') && e.key !== 'Escape') return;
      // Named keys are written in lower case in a KeyMap (enter, escape); single characters stay exact.
      const fn = ref.current[e.key.length > 1 ? e.key.toLowerCase() : e.key];
      if (fn) {
        // A shortcut that opens a form must not also type its letter into the field it focuses.
        if (e.key.length === 1) e.preventDefault();
        fn(e);
      }
    };
    addEventListener('keydown', on);
    return () => removeEventListener('keydown', on);
  }, [enabled]);
}
