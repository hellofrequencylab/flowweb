import { useEffect, useState } from 'react';

/** "14:07" in the Owner's local time. */
export function clock(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** "14:07" today, otherwise "Mon 14:07" / "3 Nov 14:07". */
export function when(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const d = new Date(iso);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return clock(iso);
  const days = (now - d.getTime()) / 86_400_000;
  if (days < 6 && days > -6) return `${d.toLocaleDateString([], { weekday: 'short' })} ${clock(iso)}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${clock(iso)}`;
}

/** "just now", "12 min ago", "3 h ago", "2 days ago". */
export function age(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** "12 min", "3 h 5 min". For durations. */
export function duration(fromIso?: string, toIso?: string, now = Date.now()): string {
  if (!fromIso) return '';
  const ms = (toIso ? new Date(toIso).getTime() : now) - new Date(fromIso).getTime();
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function usd(n: number | null | undefined, estimated = false): string {
  if (n === null || n === undefined) return '';
  return `${estimated ? 'est. ' : ''}$${n.toFixed(2)}`;
}

/** Re-render every `ms` so ages stay true. Text changes only; nothing animates. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function shortHash(h: string | undefined, head = 7, tail = 4): string {
  if (!h) return '';
  if (h.length <= head + tail + 1) return h;
  return `${h.slice(0, head)}…${h.slice(-tail)}`;
}
