// FW-C-169: the Owner's site settings, read once and shared by every page that asks: which optional panels
// a flow page shows, and the page that opens first. Until they load, or when the machine has none (an older
// fwd), nothing is hidden and nothing moves, which is how the site behaved before.
import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
import { type SiteSettings, type SiteSettingsEdit, siteSettings } from '../api/client';
import { useRouter } from '../shell/router';

type Snap = { settings: SiteSettings | null; state: 'loading' | 'ready' | 'unavailable' };
let snap: Snap = { settings: null, state: 'loading' };
let asked = false;
const listeners = new Set<() => void>();
const set = (settings: SiteSettings | null) => {
  snap = settings?.interface ? { settings, state: 'ready' } : { settings: null, state: 'unavailable' };
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
/** For tests: forget what was read. */
export const forgetSiteSettings = () => {
  asked = false;
  snap = { settings: null, state: 'loading' };
};

export function useSiteSettings(): Snap {
  useEffect(() => {
    if (asked) return;
    asked = true;
    siteSettings.get().then(set, () => set(null));
  }, []);
  return useSyncExternalStore(subscribe, () => snap);
}

/** A Settings save with the page's usual words: busy while it runs, then a line saying how it went. */
export function useSiteSave(done: string) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (edit: SiteSettingsEdit) => {
    setBusy('Saving.');
    setNote(null);
    try {
      set(await siteSettings.save(edit, () => setBusy('Saving. Waiting for your machine to apply it.')));
      setNote({ ok: true, text: done });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };
  const status = (busy || note) && (
    <span className={`setting-desc ${note && !note.ok ? 'callout-warn' : ''}`} role="status">
      {busy ?? note?.text}
    </span>
  );
  return { busy: Boolean(busy), run, status };
}
/** What a settings block says while it has nothing to show. */
export const waitingWords = (state: Snap['state']) =>
  state === 'loading' ? 'Loading.' : 'Not synced from your machine yet. Update FlowWeb there to set this.';

/** An optional panel on a flow page: shown unless the Owner hid it in Settings. */
export function Section({ name, children }: { name: string; children: ReactNode }) {
  return useSiteSettings().settings?.interface.sections[name] === false ? null : children;
}
/** The same for a whole panel component: `optional('lead-hunts', LeadHuntsPanel)`. */
export function optional<P extends object>(name: string, Panel: (props: P) => ReactNode) {
  return (props: P) => (
    <Section name={name}>
      <Panel {...props} />
    </Section>
  );
}

/** Once per browser tab, a visit that starts on the home address opens the page the Owner chose. */
export function useHomeRedirect() {
  const { loc, go } = useRouter();
  const home = useSiteSettings().settings?.interface.home;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the first answer decides; later visits to / stay there.
  useEffect(() => {
    try {
      if (!home || sessionStorage.getItem('fw.home.opened')) return;
      sessionStorage.setItem('fw.home.opened', '1');
    } catch {
      return;
    }
    if (home === 'today' || loc.path !== '/') return;
    go('/growth');
    // Drafts sit in the flow page's "Waiting on you" chapter, which appears once the flow has loaded.
    let tries = home === 'drafts' ? 40 : 0;
    const t = window.setInterval(() => {
      const el = document.getElementById('na-yours');
      el?.scrollIntoView({ block: 'start' });
      if (el || --tries <= 0) window.clearInterval(t);
    }, 250);
  }, [home]);
}
