// FW-C-092: what the AI console knows about the page, kept apart from the screen so it can be tested plainly.
import type { ConsoleProposal } from '../api/client';
import { looksLikeSecret } from '../setup/assistant';
import { type Route, routeOf } from '../shell/routes';

const NAMES: Record<Route, string> = {
  today: 'Home',
  inbox: 'Needs you',
  card: 'A decision',
  evidence: 'Evidence',
  growth: 'Flow page',
  'growth-admin': 'Flow admin',
  logs: 'Under the hood',
  row: 'A ledger row',
  runs: 'Runs',
  run: 'A run',
  projects: 'Projects',
  spend: 'Spend',
  setup: 'Get started',
  settings: 'Settings',
  more: 'More',
  start: 'Start',
};

const FLOW_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The flow in view: /flows/<key> (and anything under it), or ?flow=<key>. */
export function flowOf(path: string, query: URLSearchParams): string | null {
  const m = /^\/flows\/([^/]+)/.exec(path);
  const key = m ? decodeURIComponent(m[1]) : (query.get('flow') ?? '');
  return FLOW_KEY.test(key) ? key : null;
}

/** A person's name for the page at this address. */
export function pageName(path: string): string {
  const r = routeOf(path);
  if (r) return NAMES[r];
  return /^\/flows\/[^/]+/.test(path) ? 'Flow page' : 'This page';
}

const MAX_TEXT = 4000;

/** What the page shows, read from the screen: its heading and visible text, with key-shaped words hidden. */
export function readPage(): { heading: string; text: string } {
  const main = document.querySelector<HTMLElement>('#main') ?? document.querySelector<HTMLElement>('main');
  if (!main) return { heading: '', text: '' };
  const heading = main.querySelector('h1')?.textContent?.trim() ?? '';
  const raw = (main.innerText || main.textContent || '').replace(/\s+/g, ' ').trim();
  const text = raw
    .split(' ')
    .map((w) => (w.length >= 16 && looksLikeSecret(w) ? '[hidden]' : w))
    .join(' ')
    .slice(0, MAX_TEXT);
  return { heading, text };
}

export type ProposalState = 'open' | 'busy' | 'queued' | 'done' | 'skipped' | 'failed';
export type Proposal = ConsoleProposal & { state: ProposalState; note?: string };
/** One line of the conversation. A secret never becomes one: it is refused before this. */
export type Turn = { at: number; who: 'you' | 'ai'; text: string; failed?: boolean; proposals?: Proposal[] };

const STORE = 'fw.console.v1';

export function loadTurns(): Turn[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(STORE) ?? 'null');
    if (Array.isArray(v)) return v as Turn[];
  } catch {
    /* no storage, or not ours */
  }
  return [];
}

export function saveTurns(turns: Turn[]) {
  try {
    // A change in flight is not resumed after a reload; it reads as left open, so it can be pressed again.
    const calm = turns.slice(-40).map((t) => ({
      ...t,
      proposals: t.proposals?.map((p) => (p.state === 'busy' ? { ...p, state: 'open' as const } : p)),
    }));
    sessionStorage.setItem(STORE, JSON.stringify(calm));
  } catch {
    /* private window: the conversation lives only in this page */
  }
}

export const SECRET_REFUSAL =
  "That looks like a key or a token, so I didn't keep it or send it anywhere. Keys stay on your own computer: paste them only into your terminal when a command asks.";

/** Questions to start with, by what is on screen. */
export function starters(flow: string | null): string[] {
  return flow
    ? ['What is working best for this flow?', 'Why is this flow held?', 'Send a few more leads a day']
    : ['What is this page for?', 'Which flow needs me?', 'Pause every flow'];
}
