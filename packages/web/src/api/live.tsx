import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { HOSTED, UNREACHABLE } from '../hosted/auth';
import { api, EVENTS_URL, UnreachableError } from './client';
import type { Status, Topic } from './types';

/**
 * Connection to fwd and the global status.
 *
 * - "live": the event stream is open and the last status read is fresh.
 * - "delayed": fwd answers, but the stream dropped or reads are slow. "As of" times show everywhere.
 * - "down": fwd cannot be reached. Every value is shown as Unknown with its last known value.
 */
export type Connection = 'connecting' | 'live' | 'delayed' | 'down';

const STATUS_POLL_MS = 10_000;
const DELAYED_AFTER_MS = 30_000;

/** Which screens an event type can change. Unknown types refresh everything (safe default). */
export function topicsFor(type: string): Topic[] {
  const [area, what = ''] = type.split('.');
  switch (area) {
    case 'system':
    case 'chain':
      return ['status', 'cards', 'dawn', 'runs'];
    case 'ledger':
      return ['rows', 'dawn', 'status'];
    case 'run':
    case 'lease':
      return ['runs', 'rows', 'dawn', 'status'];
    case 'approval':
    case 'decision':
    case 'decision_card':
    case 'merge_slot':
      return ['cards', 'rows', 'status', 'dawn'];
    case 'evidence':
      return ['cards', 'rows'];
    case 'spend':
    case 'budget':
    case 'dispatch':
      return ['spend', 'status', 'dawn'];
    default:
      return what ? ['status', 'cards', 'dawn', 'rows', 'runs', 'spend'] : ['status'];
  }
}

interface LiveCtx {
  connection: Connection;
  status: Status | null;
  statusAt: number | null; // when we last received status (client clock)
  lastContactAt: number | null;
  refreshStatus: () => Promise<void>;
  subscribe: (topic: Topic, fn: () => void) => () => void;
  /** Bumped when the connection comes back, so every resource refetches. */
  reconnectEpoch: number;
}

const Ctx = createContext<LiveCtx | null>(null);

export function LiveProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [statusAt, setStatusAt] = useState<number | null>(null);
  const [lastContactAt, setLastContactAt] = useState<number | null>(null);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [streamOpen, setStreamOpen] = useState(false);
  const [reconnectEpoch, setReconnectEpoch] = useState(0);
  const [now, setNow] = useState(Date.now());
  const subs = useRef(new Map<Topic, Set<() => void>>());
  const wasDown = useRef(false);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await api.status();
      setStatus(s);
      setStatusAt(Date.now());
      setLastContactAt(Date.now());
      setReachable(true);
      if (wasDown.current) {
        wasDown.current = false;
        setReconnectEpoch((e) => e + 1);
      }
    } catch (e) {
      if (e instanceof UnreachableError) {
        setReachable(false);
        wasDown.current = true;
      }
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    const t = setInterval(refreshStatus, STATUS_POLL_MS);
    const n = setInterval(() => setNow(Date.now()), 5_000);
    return () => {
      clearInterval(t);
      clearInterval(n);
    };
  }, [refreshStatus]);

  // Event stream. EventSource resumes with Last-Event-ID on its own after a drop.
  useEffect(() => {
    // The hosted mirror has no event stream; it refreshes by polling and shows data age.
    if (HOSTED || typeof EventSource === 'undefined') return;
    const es = new EventSource(EVENTS_URL, { withCredentials: true });
    es.onopen = () => setStreamOpen(true);
    es.onerror = () => setStreamOpen(false);
    const onEvent = (m: MessageEvent<string>) => {
      setLastContactAt(Date.now());
      let ev: { type?: string };
      try {
        ev = JSON.parse(m.data) as { type?: string };
      } catch {
        return;
      }
      const topics = new Set<Topic>(topicsFor(ev.type ?? ''));
      for (const t of topics) {
        for (const fn of subs.current.get(t) ?? []) fn();
      }
      if (topics.has('status')) refreshStatus();
    };
    es.addEventListener('fw', onEvent as EventListener);
    es.onmessage = onEvent;
    return () => es.close();
  }, [refreshStatus]);

  const subscribe = useCallback((topic: Topic, fn: () => void) => {
    let set = subs.current.get(topic);
    if (!set) {
      set = new Set();
      subs.current.set(topic, set);
    }
    const mine = set;
    mine.add(fn);
    return () => {
      mine.delete(fn);
    };
  }, []);

  let connection: Connection;
  if (reachable === null) connection = 'connecting';
  else if (!reachable) connection = 'down';
  else if (!streamOpen || (statusAt !== null && now - statusAt > DELAYED_AFTER_MS)) connection = 'delayed';
  else connection = 'live';

  return (
    <Ctx.Provider
      value={{ connection, status, statusAt, lastContactAt, refreshStatus, subscribe, reconnectEpoch }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useLive(): LiveCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useLive outside LiveProvider');
  return c;
}

/** True when approve and other write actions must be disabled, with the reason. */
export function useWriteBlock(): string | null {
  const { connection, status } = useLive();
  if (connection === 'down' || connection === 'connecting')
    return `${UNREACHABLE}. Approvals need a live connection.`;
  if (status?.kill_switch.state === 'stopped' || status?.kill_switch.state === 'stopping')
    return 'Everything is stopped. Release the kill switch to approve.';
  return null;
}

/** The global status as a Resource, so screens can use the same honest components. */
export function useStatusResource(): import('./resource').Resource<Status> {
  const { status, connection, refreshStatus } = useLive();
  const honesty = !status
    ? connection === 'down'
      ? 'unknown'
      : 'loading'
    : connection === 'down'
      ? 'stale'
      : 'current';
  return {
    data: status,
    error: null,
    honesty,
    asOf: status?.data_as_of ?? null,
    reload: () => void refreshStatus(),
  };
}
