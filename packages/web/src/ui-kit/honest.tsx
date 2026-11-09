import { type ReactNode, useState } from 'react';
import { ApiError } from '../api/client';
import type { Resource } from '../api/resource';
import type { Envelope } from '../api/types';
import { UNREACHABLE } from '../hosted/auth';
import { age, clock, useNow } from './time';

/**
 * One value from fwd, shown honestly:
 * - current: the value
 * - stale: "Unknown" with "Last known: X, 12 min ago" underneath
 * - unknown/loading: "Unknown" / "Loading"
 * A blank is never a zero: if the value itself is undefined we say Unknown.
 */
export function Fact<T extends Envelope, V>({
  res,
  pick,
  format = (v) => String(v),
}: {
  res: Resource<T>;
  pick: (d: T) => V | undefined | null;
  format?: (v: V) => ReactNode;
}) {
  const now = useNow();
  const v = res.data ? pick(res.data) : undefined;
  if (res.honesty === 'loading') return <span className="muted">Loading</span>;
  if (res.honesty === 'current' && v !== undefined && v !== null) return <>{format(v)}</>;
  return (
    <span>
      <span className="fact-unknown">Unknown</span>
      {res.data && v !== undefined && v !== null && (
        <span className="fact-lastknown">
          Last known: {format(v)}, {age(res.asOf, now)}
        </span>
      )}
    </span>
  );
}

/** "as of 14:07". Becomes prominent when the data cannot be vouched for. */
export function AsOf({ res, label = 'as of' }: { res: Resource<Envelope>; label?: string }) {
  const now = useNow();
  if (!res.asOf) return null;
  return (
    <span className="asof" title={res.asOf}>
      {res.honesty === 'current'
        ? `${label} ${clock(res.asOf)}`
        : `Last update ${clock(res.asOf)}, ${age(res.asOf, now)}`}
    </span>
  );
}

export function Loading({ what }: { what: string }) {
  return <p className="muted">Loading {what}.</p>;
}

export function LoadError({
  what,
  error,
  onRetry,
}: {
  what: string;
  error: Error | null;
  onRetry: () => void;
}) {
  const msg =
    error instanceof ApiError ? `fwd answered: ${error.message} (${error.code}).` : `${UNREACHABLE}.`;
  return (
    <div className="callout callout-warn" role="alert">
      <p>
        <strong>Could not load {what}.</strong> {msg} Nothing here is shown as current.
      </p>
      <button type="button" className="btn" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted">{children}</p>;
}

/**
 * A section that loads and fails on its own. Data held from before a failure
 * is still rendered (children decide how), under a stale notice.
 */
export function ResourceView<T extends Envelope>({
  res,
  what,
  children,
}: {
  res: Resource<T>;
  what: string;
  children: (d: T, honest: boolean) => ReactNode;
}) {
  if (res.honesty === 'loading') return <Loading what={what} />;
  if (!res.data) return <LoadError what={what} error={res.error} onRetry={res.reload} />;
  return (
    <>
      {res.honesty === 'stale' && <StaleNotice res={res} what={what} />}
      {children(res.data, res.honesty === 'current')}
    </>
  );
}

export function StaleNotice({ res, what }: { res: Resource<Envelope>; what: string }) {
  const now = useNow();
  return (
    <div className="callout callout-warn" role="status" style={{ marginBottom: 'var(--fw-space-4)' }}>
      <strong>Not current.</strong> This {what} is from {clock(res.asOf)}, {age(res.asOf, now)}. Values below
      are the last known, not the present.{' '}
      <button type="button" className="btn btn-quiet" onClick={res.reload}>
        Retry
      </button>
    </div>
  );
}

export function Copy({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-quiet"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        });
      }}
      aria-label={`Copy ${label ?? text}`}
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}
