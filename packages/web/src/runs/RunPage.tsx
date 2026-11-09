import { useState } from 'react';
import { api } from '../api/client';
import { type Resource, useResource } from '../api/resource';
import type { EventList as Events } from '../api/types';
import { Link } from '../shell/router';
import { AsOf, LoadError, Loading, ResourceView } from '../ui-kit/honest';
import { Icon } from '../ui-kit/Icon';
import { PageHead } from '../ui-kit/page';
import { runStatusSpec, SANDBOX, StatusLabel, VERDICT } from '../ui-kit/status';
import { clock, duration, usd, useNow, when } from '../ui-kit/time';

export function RunPage({ id }: { id: string }) {
  const res = useResource(`run:${id}`, () => api.run(id), ['runs']);
  const steps = useResource(`steps:${id}`, () => api.runSteps(id), ['runs']);
  const events = useResource(`run-events:${id}`, () => api.events({ run_id: id }), ['runs']);
  const [sel, setSel] = useState<string | null>(null);
  const now = useNow(15_000);

  return (
    <ResourceView res={res} what="run">
      {(d) => {
        const r = d.run;
        const spec = runStatusSpec(r.status, r.heartbeat_at ?? undefined, now);
        return (
          <div className="stack">
            <nav className="crumbs" aria-label="Breadcrumb">
              <Link to="/runs">
                <Icon name="arrow-left" /> Runs
              </Link>
            </nav>
            <PageHead
              overline="Run"
              title={<span className="mono-title">{r.run_id}</span>}
              lede={
                <span className="page-meta">
                  <AsOf res={res} />
                </span>
              }
            />
            <p className="row">
              <StatusLabel spec={spec} />
              {r.row_id && (
                <Link to={`/ledger/lr_${r.row_id.replace(/-/g, '')}`} className="mono">
                  {r.row_id}
                </Link>
              )}
              <span className="muted small">
                {r.role ?? 'agent'} · {r.vendor}
              </span>
            </p>
            {r.status === 'claimed_unverified' && (
              <p className="callout callout-warn">
                The agent said it was done, but the kernel found no artifact that proves it (
                {r.failure_class?.replace(/_/g, ' ')}).
              </p>
            )}

            <section className="panel">
              <h2>Summary</h2>
              <dl className="facts">
                <dt>Started</dt>
                <dd>{r.started_at ? when(r.started_at, now) : 'Not started'}</dd>
                <dt>Duration</dt>
                <dd>
                  {r.started_at
                    ? duration(r.started_at, r.ended_at, now) + (r.ended_at ? '' : ' so far')
                    : ''}
                </dd>
                <dt>Cost</dt>
                <dd>{usd(r.cost_usd, r.cost_estimated)}</dd>
                <dt>Tokens</dt>
                <dd>
                  {r.input_tokens.toLocaleString()} in, {r.output_tokens.toLocaleString()} out · {r.turns}{' '}
                  turns
                </dd>
                <dt>Exit code</dt>
                <dd>{r.exit_code ?? <span className="muted">none yet</span>}</dd>
                <dt>Agent tool</dt>
                <dd>
                  {r.adapter} {r.tool_version ?? <span className="fact-unknown">version unknown</span>}
                  {r.model ? ` · ${r.model}` : ''}
                </dd>
                <dt>Sandbox</dt>
                <dd>
                  <StatusLabel spec={SANDBOX[r.sandbox]} />
                </dd>
                {r.branch && (
                  <>
                    <dt>Branch</dt>
                    <dd className="mono">{r.branch}</dd>
                  </>
                )}
              </dl>
            </section>

            <section className="panel">
              <h2>Steps</h2>
              <p className="xs muted">
                Written by the platform, not the agent. Text from outside is marked as data.
              </p>
              {steps.honesty === 'loading' && <Loading what="steps" />}
              {!steps.data && steps.honesty !== 'loading' && (
                <LoadError what="steps" error={steps.error} onRetry={steps.reload} />
              )}
              {steps.data && (
                <ol className="plain-list">
                  {steps.data.steps.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        className="step-btn"
                        aria-expanded={sel === s.id}
                        onClick={() => setSel(sel === s.id ? null : s.id)}
                      >
                        <span className="step-time mono">{clock(s.at)}</span>
                        {s.blocked_by_policy ? <Icon name="blocked" /> : null}
                        <span className="step-label">{s.label}</span>
                        <Icon name={sel === s.id ? 'chevron-down' : 'chevron-right'} />
                      </button>
                      {s.blocked_by_policy && (
                        <div className="small">
                          <StatusLabel spec={{ word: s.blocked_by_policy, tone: 'warn', icon: 'blocked' }} />
                        </div>
                      )}
                      {sel === s.id && (
                        <div className="stack" style={{ marginTop: 'var(--fw-space-2)' }}>
                          {s.external_text && <p className="chip">Data, not instructions</p>}
                          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (WCAG 2.1.1) */}
                          <pre className="output" tabIndex={0}>
                            {s.excerpt || '(no excerpt)'}
                          </pre>
                          <p className="xs muted">
                            {s.kind} · {usd(s.cost_usd)} ·{' '}
                            {s.ended_at ? `ended ${clock(s.ended_at)}` : 'not ended'}
                          </p>
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className="panel">
              <h2>Artifacts</h2>
              <h3 className="h-line">Verified by the system</h3>
              {d.artifacts_verified.length === 0 ? (
                <p className="muted small">None. Nothing from this run has been verified.</p>
              ) : (
                <ul className="plain-list">
                  {d.artifacts_verified.map((a) => (
                    <li key={a.ref} className="row">
                      <StatusLabel spec={{ word: 'Verified', tone: 'ok', icon: 'pass' }} />
                      <span>{a.kind.replace(/_/g, ' ')}</span>
                      {/^https?:/.test(a.ref) ? (
                        <a href={a.ref}>{a.ref}</a>
                      ) : (
                        <span className="mono">{a.ref}</span>
                      )}
                      {a.verified_at && <span className="asof">{when(a.verified_at, now)}</span>}
                    </li>
                  ))}
                </ul>
              )}
              <h3 className="h-line" style={{ marginTop: 'var(--fw-space-4)' }}>
                Claimed by the agent, not verified
              </h3>
              {d.artifacts_claimed.length === 0 ? (
                <p className="muted small">No unverified claims.</p>
              ) : (
                <ul className="plain-list">
                  {d.artifacts_claimed.map((a) => (
                    <li key={a.id} className="row">
                      <StatusLabel spec={{ word: 'Not verified', tone: 'unknown', icon: 'notverified' }} />
                      <span>{a.claim}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="panel">
              <div className="panel-head">
                <h2>Verifier</h2>
                <span className="asof">Advice, not a gate</span>
              </div>
              {d.verifier ? (
                <>
                  <p className="row">
                    <StatusLabel spec={VERDICT[d.verifier.verdict]} />{' '}
                    <span className="muted small">vendor: {d.verifier.vendor}</span>
                  </p>
                  <p>{d.verifier.summary}</p>
                  {d.verifier.same_vendor_review && (
                    <p className="callout callout-warn small">Same vendor as the agent that did the work.</p>
                  )}
                </>
              ) : (
                <p className="muted">No verifier result for this run.</p>
              )}
            </section>

            <section className="panel">
              <h2>Events</h2>
              <EventList res={events} />
            </section>
          </div>
        );
      }}
    </ResourceView>
  );
}

export function EventList({ res }: { res: Resource<Events> }) {
  const now = useNow();
  if (res.honesty === 'loading') return <Loading what="events" />;
  if (!res.data) return <LoadError what="events" error={res.error} onRetry={res.reload} />;
  if (res.data.events.length === 0) return <p className="muted small">No events recorded.</p>;
  return (
    <ol className="plain-list small">
      {res.data.events.map((e) => (
        <li key={e.seq} className="row">
          <span className="mono xs muted">#{e.seq}</span>
          <span className="mono xs">{e.type}</span>
          <span>{e.summary}</span>
          <span className="spacer" />
          <span className="asof">{when(e.ts, now)}</span>
        </li>
      ))}
    </ol>
  );
}
