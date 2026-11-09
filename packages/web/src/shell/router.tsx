import {
  type AnchorHTMLAttributes,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from 'react';

/** Minimal history router. fwd serves index.html for every non-API path. */

interface Loc {
  path: string;
  query: URLSearchParams;
}
const read = (): Loc => ({ path: location.pathname, query: new URLSearchParams(location.search) });
const Ctx = createContext<{ loc: Loc; go: (to: string) => void } | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const on = () => setLoc(read());
    addEventListener('popstate', on);
    return () => removeEventListener('popstate', on);
  }, []);
  const go = (to: string) => {
    if (to === location.pathname + location.search) return;
    history.pushState(null, '', to);
    setLoc(read());
    window.scrollTo(0, 0);
    // Move focus to the page heading for screen readers.
    requestAnimationFrame(() => document.querySelector<HTMLElement>('main h1')?.focus());
  };
  return <Ctx.Provider value={{ loc, go }}>{children}</Ctx.Provider>;
}

export function useRouter() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useRouter outside RouterProvider');
  return c;
}

/** Match "/runs/:id" against a path. Returns params or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/').filter(Boolean);
  const b = path.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) out[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return out;
}

export function Link({
  to,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; children: ReactNode }) {
  const { go } = useRouter();
  return (
    <a
      href={to}
      {...rest}
      onClick={(e) => {
        rest.onClick?.(e);
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        go(to);
      }}
    >
      {children}
    </a>
  );
}
