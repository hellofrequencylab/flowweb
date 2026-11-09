import { useCallback, useEffect, useRef, useState } from 'react';
import { useLive } from './live';
import type { Envelope, Topic } from './types';

/**
 * How a value may be shown.
 * - current: fresh from fwd.
 * - stale: we have a last known value but cannot vouch for it now. Show "Unknown" + last known.
 * - unknown: nothing known yet and the read failed.
 * - loading: first read in flight.
 */
export type Honesty = 'current' | 'stale' | 'unknown' | 'loading';

export interface Resource<T extends Envelope> {
  data: T | null;
  error: Error | null;
  honesty: Honesty;
  /** data_as_of of the data we hold, from fwd. */
  asOf: string | null;
  reload: () => void;
}

/**
 * Fetches a resource, keeps the last good value on failure, and refetches when
 * the live stream says something it depends on changed. The last good value is
 * never presented as current once a read fails or fwd is unreachable.
 */
export function useResource<T extends Envelope>(
  key: string,
  fetcher: () => Promise<T>,
  topics: Topic[] = [],
): Resource<T> {
  const { connection, subscribe, reconnectEpoch } = useLive();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const seq = useRef(0);

  const load = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true);
    fetcherRef
      .current()
      .then((d) => {
        if (mine !== seq.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: Error) => {
        if (mine !== seq.current) return;
        setError(e);
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  }, []);

  // New key: drop the old data entirely; it belonged to something else.
  // biome-ignore lint/correctness/useExhaustiveDependencies: key and reconnectEpoch are refetch triggers, not values read here
  useEffect(() => {
    setData(null);
    setError(null);
    load();
  }, [key, load, reconnectEpoch]);

  const topicKey = topics.join(',');
  useEffect(() => {
    const offs = topicKey ? topicKey.split(',').map((t) => subscribe(t as Topic, load)) : [];
    return () => {
      for (const off of offs) off();
    };
  }, [topicKey, subscribe, load]);

  let honesty: Honesty;
  const cannotVouch = connection === 'down' || error !== null;
  if (data && !cannotVouch) honesty = 'current';
  else if (data) honesty = 'stale';
  else if (loading && connection !== 'down') honesty = 'loading';
  else honesty = 'unknown';

  return { data, error, honesty, asOf: data?.data_as_of ?? null, reload: load };
}
