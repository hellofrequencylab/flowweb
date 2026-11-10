// The runs fwd hosts: every `POST /v1/runs` pipeline runs here, under one abort signal. On stop,
// fwd stops taking runs, aborts the signal (the pipeline kills each vendor process group and ends
// the run as killed with an "interrupted" terminal event) and waits for every run to be recorded
// before it writes system.stopped.

export class RunHostStoppingError extends Error {
  readonly code = 'UNAVAILABLE';
  constructor(message = 'fwd is stopping; no new runs') {
    super(message);
    this.name = 'RunHostStoppingError';
  }
}

export class RunHost {
  private readonly ctrl = new AbortController();
  private readonly live = new Set<Promise<unknown>>();
  private accepting = true;

  /** Runs in flight (including their HTTP answer). */
  get size(): number {
    return this.live.size;
  }

  get stopping(): boolean {
    return !this.accepting;
  }

  /** Runs fn under the host's abort signal and tracks it until it settles. */
  track<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(new RunHostStoppingError());
    const p = fn(this.ctrl.signal);
    const tracked = p.then(
      () => undefined,
      () => undefined,
    );
    this.live.add(tracked);
    void tracked.then(() => this.live.delete(tracked));
    return p;
  }

  /**
   * Stops taking runs, aborts the ones in flight with `reason`, and waits up to timeoutMs for all of
   * them to settle. Returns how many were in flight and whether every one settled in time.
   */
  async drain(reason: string, timeoutMs: number): Promise<{ interrupted: number; settled: boolean }> {
    this.accepting = false;
    const interrupted = this.live.size;
    if (interrupted === 0) return { interrupted, settled: true };
    this.ctrl.abort(reason);
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      Promise.all([...this.live]).then(() => true),
      new Promise<boolean>((ok) => {
        timer = setTimeout(() => ok(false), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    return { interrupted, settled };
  }
}
