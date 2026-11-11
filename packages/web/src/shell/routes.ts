import { match } from './router';

/** The pages FlowWeb shows, one per address. Old addresses stay so links and bookmarks keep working. */
export type Route =
  | 'today'
  | 'inbox'
  | 'card'
  | 'evidence'
  | 'growth'
  | 'growth-admin'
  | 'logs'
  | 'row'
  | 'runs'
  | 'run'
  | 'projects'
  | 'spend'
  | 'setup'
  | 'settings'
  | 'more'
  | 'start'
  | 'team';

const EXACT: Record<string, Route> = {
  '/': 'today',
  '/inbox': 'inbox',
  '/table': 'inbox',
  '/growth': 'growth',
  '/flows': 'today',
  '/growth/admin': 'growth-admin',
  '/hood': 'logs',
  '/ledger': 'logs',
  '/runs': 'runs',
  '/projects': 'projects',
  '/spend': 'spend',
  '/setup': 'setup',
  '/settings': 'settings',
  '/more': 'more',
  '/start': 'start',
  '/team': 'team',
};

const PARAM: [string, Route][] = [
  ['/flows/:key', 'growth'],
  ['/inbox/:card', 'card'],
  ['/table/:card', 'card'],
  ['/evidence/:id', 'evidence'],
  ['/ledger/:id', 'row'],
  ['/runs/:id', 'run'],
];

/** Which page an address shows, or null when there is none. */
export function routeOf(path: string): Route | null {
  const p = path.length > 1 ? path.replace(/\/+$/, '') : path;
  if (p in EXACT) return EXACT[p];
  for (const [pattern, r] of PARAM) if (match(pattern, p)) return r;
  return null;
}

/** The id in an address with one (/runs/:id and the like). */
export function paramOf(path: string): string {
  for (const [pattern] of PARAM) {
    const m = match(pattern, path);
    if (m) return Object.values(m)[0];
  }
  return '';
}

/** Which of the four nav tabs an address belongs to. Settings and Get started belong to none. */
export type Tab = '/' | '/inbox' | '/team' | '/hood';
export function tabOf(path: string): Tab | null {
  switch (routeOf(path)) {
    case 'today':
    case 'growth':
    case 'growth-admin':
      return '/';
    case 'inbox':
    case 'card':
    case 'evidence':
      return '/inbox';
    case 'team':
      return '/team';
    case 'logs':
    case 'row':
    case 'runs':
    case 'run':
    case 'projects':
    case 'spend':
      return '/hood';
    default:
      return null;
  }
}
