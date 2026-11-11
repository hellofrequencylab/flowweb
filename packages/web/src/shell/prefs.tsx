import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';

/** Per-browser display preferences. Not state fwd needs to know. */
export interface Prefs {
  calm: boolean;
  rewards: boolean;
  rewardTableCleared: boolean;
  rewardCargoLanded: boolean;
  motion: 'system' | 'reduced';
  theme: 'system' | 'light' | 'dark';
  density: 'comfortable' | 'compact';
  shortcuts: boolean;
  killMode: 'hold' | 'arm';
  /** FW-C-099: the colour of the site's flowing loops, glows and live edges. */
  accent: Accent;
}

/** Accent colours from the design system's flow hues. None is saffron, green, red or the warning purple. */
export const ACCENTS = ['teal', 'slate', 'indigo', 'olive', 'clay'] as const;
export type Accent = (typeof ACCENTS)[number];

const DEFAULTS: Prefs = {
  calm: false,
  rewards: true,
  rewardTableCleared: true,
  rewardCargoLanded: true,
  motion: 'system',
  theme: 'system',
  density: 'comfortable',
  shortcuts: true,
  killMode: 'hold',
  accent: 'teal',
};

const KEY = 'fw.prefs.v1';

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    /* storage blocked: defaults */
  }
  return DEFAULTS;
}

const Ctx = createContext<{ prefs: Prefs; set: (p: Partial<Prefs>) => void } | null>(null);

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* ignore */
    }
    const r = document.documentElement;
    if (prefs.theme === 'system') r.removeAttribute('data-theme');
    else r.setAttribute('data-theme', prefs.theme);
    r.setAttribute('data-density', prefs.density);
    if (prefs.accent === 'teal' || !ACCENTS.includes(prefs.accent)) r.removeAttribute('data-accent');
    else r.setAttribute('data-accent', prefs.accent);
    r.setAttribute('data-calm', prefs.calm || prefs.motion === 'reduced' ? 'on' : 'off');
  }, [prefs]);
  return (
    <Ctx.Provider value={{ prefs, set: (p) => setPrefs((o) => ({ ...o, ...p })) }}>{children}</Ctx.Provider>
  );
}

export function usePrefs() {
  const c = useContext(Ctx);
  if (!c) throw new Error('usePrefs outside PrefsProvider');
  return c;
}

/** True when nothing should animate: calm mode, reduced motion setting, or the OS asks. */
export function useStill(): boolean {
  const { prefs } = usePrefs();
  const os = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  return prefs.calm || prefs.motion === 'reduced' || os;
}
