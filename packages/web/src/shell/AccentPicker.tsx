import type { CSSProperties } from 'react';
import { ACCENTS, type Accent, usePrefs } from './prefs';

const NAME: Record<Accent, string> = {
  teal: 'Teal',
  slate: 'Harbor blue',
  indigo: 'Indigo',
  olive: 'Olive',
  clay: 'Clay',
};

/**
 * FW-C-099: a compact row of swatches for the site's accent, the colour of flowing loops, glows and live
 * edges. It is saved in this browser only. Status colours (saffron waiting, purple warning) never change.
 */
export function AccentPicker() {
  const { prefs, set } = usePrefs();
  return (
    <fieldset className="setting setting-choice accent-picker">
      <legend className="visually-hidden">Accent</legend>
      <span className="setting-text" aria-hidden="true">
        <span className="setting-label">Accent</span>
        <span className="setting-desc">The colour of flowing loops and glows. {NAME[prefs.accent]}.</span>
      </span>
      <span className="accent-swatches">
        {ACCENTS.map((a) => (
          <label key={a} className="accent-swatch" style={{ '--sw': `var(--flow-${a})` } as CSSProperties}>
            <input
              type="radio"
              name="accent"
              value={a}
              checked={prefs.accent === a}
              onChange={() => set({ accent: a })}
            />
            <span className="accent-dot" aria-hidden="true" />
            <span className="visually-hidden">{NAME[a]}</span>
          </label>
        ))}
      </span>
    </fieldset>
  );
}
