import { api } from '../api/client';
import { type Resource, useResource } from '../api/resource';
import type { CheckStatus, Evidence, ParsedDiff } from '../api/types';
import { Donut, RunTrace, type Slice, type TraceStatus } from '../ui-kit/flow';
import { Copy, LoadError, Loading } from '../ui-kit/honest';
import { CHECK_STATUS, SANDBOX, StatusLabel, VERDICT } from '../ui-kit/status';
import { clock, shortHash, usd } from '../ui-kit/time';

export function useEvidence(id: string | undefined) {
  return useResource(
    `evidence:${id}`,
    () => (id ? api.evidence(id) : Promise.reject(new Error('No evidence bundle'))),
    ['cards'],
  );
}
export function useDiff(id: string | undefined) {
  return useResource(`diff:${id}`, () =>
    id ? api.evidenceDiff(id) : Promise.reject(new Error('No evidence bundle')),
  );
}

/**
 * Judge a change in under a minute without trusting the agent's summary.
 * Each section loads and fails on its own, with Retry.
 */
/** Each check status as a trace step. Skipped is never a pass, so it never gets the tick. */
const CHECK_TRACE: Record<CheckStatus, TraceStatus> = {
  pass: 'done',
  fail: 'failed',
  warn: 'blocked',
  skipped: 'skipped',
  pending: 'pending',
};

/** How many checks passed, as a small donut with the count in words beside it. */
function ChecksSummary({ checks }: { checks: Evidence['checks'] }) {
  const count = (s: CheckStatus) => checks.filter((c) => c.status === s).length;
  const slices: Slice[] = [
    { key: 'pass', label: 'Passed', value: count('pass'), tone: 'ok' },
    { key: 'fail', label: 'Failed', value: count('fail'), tone: 'fail' },
    { key: 'warn', label: 'Warnings', value: count('warn'), tone: 'warn' },
    { key: 'skipped', label: 'Not verified', value: count('skipped') + count('pending'), tone: 'unknown' },
  ];
  const words = slices.filter((s) => s.value > 0).map((s) => `${s.value} ${s.label.toLowerCase()}`);
  return (
    <div className="checks-summary">
      <Donut
        size={64}
        slices={slices}
        center={`${count('pass')}/${checks.length}`}
        label={`${count('pass')} of ${checks.length} checks passed`}
      />
      <span className="small">
        <strong>
          {count('pass')} of {checks.length} passed
        </strong>
        {words.length > 1 && <span className="muted"> · {words.slice(1).join(', ')}</span>}
      </span>
    </div>
  );
}

export function EvidenceView({
  ev,
  diff,
  payloadHash,
}: {
  ev: Resource<Evidence>;
  diff: Resource<ParsedDiff>;
  payloadHash?: string;
}) {
  const e = ev.data;
  return (
    <section className="stack" aria-label="Evidence">
      {e?.scan_red && (
        <div className="callout callout-fail" role="alert">
          <strong>The {failedScanNames(e)} failed. This change cannot be approved.</strong>
        </div>
      )}

      <section className="panel" aria-labelledby="ev-checks">
        <div className="panel-head">
          <h3 id="ev-checks">Automated checks</h3>
          {e && (
            <span className="asof">
              captured by {e.captured_by === 'kernel' ? 'the kernel' : 'the CI sandbox'}
            </span>
          )}
        </div>
        {ev.honesty === 'loading' && <Loading what="checks" />}
        {!e && ev.honesty !== 'loading' && (
          <LoadError what="the evidence" error={ev.error} onRetry={ev.reload} />
        )}
        {e && (
          <>
            <ChecksSummary checks={e.checks} />
            <RunTrace
              steps={e.checks.map((c) => ({
                key: c.name,
                status: CHECK_TRACE[c.status],
                name: (
                  <>
                    {c.name}
                    {c.status !== 'pass' && <span className="muted"> · {CHECK_STATUS[c.status].word}</span>}
                  </>
                ),
                detail: (c.summary || c.artifact_ref) && (
                  <span className="trace-lines">
                    {c.summary && <span>{c.summary}</span>}
                    {c.artifact_ref && <RefLink r={c.artifact_ref} label="Output" copy={false} />}
                  </span>
                ),
                aside: `ran ${clock(c.ran_at)}`,
              }))}
            />
            {e.not_verified.length > 0 && (
              <p className="small muted">
                Not verified: {e.not_verified.join(', ')}. Skipped checks are never counted as a pass.
              </p>
            )}
          </>
        )}
      </section>

      {e && (
        <section className="panel" aria-labelledby="ev-verifier">
          <div className="panel-head">
            <h3 id="ev-verifier">Verifier</h3>
            <span className="asof">Advice, not a gate</span>
          </div>
          {e.independent_check ? (
            <>
              <p className="row">
                <StatusLabel spec={VERDICT[e.independent_check.verdict]} />
                <span className="muted small">vendor: {e.independent_check.vendor}</span>
              </p>
              {e.independent_check.summary && <p>{e.independent_check.summary}</p>}
              {e.independent_check.same_vendor_review && (
                <p className="callout callout-warn small">
                  Same vendor as the agent that made the change. Treat this review as weaker.
                </p>
              )}
            </>
          ) : (
            <p className="muted">No verifier ran on this change. Not verified.</p>
          )}
        </section>
      )}

      {e && (
        <section className="panel" aria-labelledby="ev-blast">
          <h3 id="ev-blast">Blast radius and rollback</h3>
          <dl className="facts">
            <dt>Affected</dt>
            <dd>{e.blast_radius.summary}</dd>
            <dt>Can be undone</dt>
            <dd>{e.blast_radius.reversible ? 'Yes' : 'No'}</dd>
            <dt>Rollback plan</dt>
            <dd>{e.blast_radius.rollback_plan}</dd>
            <dt>Rollback tested</dt>
            <dd>
              {e.blast_radius.rollback_tested ? (
                'Yes'
              ) : (
                <StatusLabel spec={{ word: 'No, not verified', tone: 'unknown', icon: 'notverified' }} />
              )}
            </dd>
          </dl>
        </section>
      )}

      <section className="panel" aria-labelledby="ev-diff">
        <div className="panel-head">
          <h3 id="ev-diff">The change</h3>
          {e && <span className="asof">exact lines being approved</span>}
        </div>
        {e && e.tests_removed_or_skipped.length > 0 && (
          <div className="callout callout-warn" role="alert" style={{ marginBottom: 'var(--fw-space-3)' }}>
            <strong>Tests deleted or skipped:</strong>
            <ul>
              {e.tests_removed_or_skipped.map((t) => (
                <li key={t} className="mono">
                  {t}
                </li>
              ))}
            </ul>
          </div>
        )}
        <DiffSection diff={diff} expectedHash={e?.diff_hash} payloadHash={payloadHash ?? e?.payload_hash} />
      </section>

      {e && (
        <section className="panel" aria-labelledby="ev-probe">
          <h3 id="ev-probe">Probe output</h3>
          {e.probe ? (
            <>
              <p className="row">
                <StatusLabel
                  spec={e.probe.exit_code === 0 ? CHECK_STATUS.pass : CHECK_STATUS.fail}
                  detail={`exit code ${e.probe.exit_code}`}
                />
                <span className="muted small">{(e.probe.duration_ms / 1000).toFixed(1)} s</span>
                {e.probe.output_ref && <RefLink r={e.probe.output_ref} label="Full output" />}
              </p>
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (WCAG 2.1.1) */}
              <pre className="output" tabIndex={0}>
                {e.probe.tail}
              </pre>
            </>
          ) : (
            <p className="muted">No probe output in this bundle. Not verified.</p>
          )}
        </section>
      )}

      {e && (
        <section className="panel" aria-labelledby="ev-cost">
          <h3 id="ev-cost">Cost, sandbox and hashes</h3>
          <dl className="facts">
            <dt>Cost</dt>
            <dd>
              {e.cost.usd !== undefined ? (
                usd(e.cost.usd, e.cost.estimated)
              ) : (
                <span className="fact-unknown">Unknown</span>
              )}
            </dd>
            <dt>Tokens</dt>
            <dd>
              {e.cost.input_tokens !== undefined ? (
                <>
                  {e.cost.estimated ? 'est. ' : ''}
                  {e.cost.input_tokens.toLocaleString()} in, {e.cost.output_tokens?.toLocaleString()} out
                </>
              ) : (
                <span className="fact-unknown">Unknown</span>
              )}
            </dd>
            <dt>Sandbox</dt>
            <dd>
              {e.sandbox ? (
                <>
                  <StatusLabel spec={SANDBOX[e.sandbox.level]} />
                  {e.sandbox.controls.length > 0 && (
                    <span className="muted small"> · {e.sandbox.controls.join(', ')}</span>
                  )}
                </>
              ) : (
                <span className="fact-unknown">Unknown</span>
              )}
            </dd>
            <dt>Agent tool</dt>
            <dd>
              {e.adapter ? (
                `${e.adapter.name} ${e.adapter.version}`
              ) : (
                <span className="fact-unknown">Unknown</span>
              )}
            </dd>
            <dt>Payload hash</dt>
            <dd className="row">
              <span className="hash">{shortHash(e.payload_hash, 12, 6)}</span>{' '}
              <Copy text={e.payload_hash} label="payload hash" />
            </dd>
            <dt>Commit</dt>
            <dd className="row">
              {e.subject.sha ? (
                <>
                  <span className="hash">{shortHash(e.subject.sha, 12, 6)}</span>{' '}
                  <Copy text={e.subject.sha} label="commit" />
                </>
              ) : (
                <span className="fact-unknown">Unknown</span>
              )}
            </dd>
            <dt>Evidence bundle</dt>
            <dd className="row">
              <span className="hash">{e.bundle_id}</span> <Copy text={e.bundle_id} label="bundle id" />
            </dd>
          </dl>
        </section>
      )}

      {e && e.screenshots.length === 0 && <p className="muted small">This change has no screenshots.</p>}
    </section>
  );
}

function DiffSection({
  diff,
  expectedHash,
  payloadHash,
}: {
  diff: Resource<ParsedDiff>;
  expectedHash?: string;
  payloadHash?: string;
}) {
  if (diff.honesty === 'loading') return <Loading what="the diff" />;
  if (!diff.data) return <LoadError what="the diff" error={diff.error} onRetry={diff.reload} />;
  const d = diff.data;
  const matches = Boolean(expectedHash && d.sha256 === expectedHash);
  return (
    <>
      <p className="small">
        {!d.sha256 ? (
          <StatusLabel
            spec={{
              word: 'Diff hash not checked (browser cannot hash here)',
              tone: 'unknown',
              icon: 'notverified',
            }}
          />
        ) : matches ? (
          <StatusLabel
            spec={{
              word: `These lines hash to ${shortHash(d.sha256)}${payloadHash === d.sha256 ? ', the payload hash you approve' : ", the bundle's diff hash"}`,
              tone: 'ok',
              icon: 'pass',
            }}
          />
        ) : (
          <StatusLabel
            spec={{
              word: `These lines hash to ${shortHash(d.sha256)}, which does not match the bundle (${shortHash(expectedHash)})`,
              tone: 'fail',
              icon: 'fail',
            }}
          />
        )}
      </p>
      {d.files.length === 0 && <p className="muted">The diff is empty.</p>}
      {d.files.map((f) => (
        <section
          className="diff"
          key={f.path}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (WCAG 2.1.1)
          tabIndex={0}
          aria-label={`Diff of ${f.path}`}
          style={{ marginBottom: 'var(--fw-space-3)' }}
        >
          <div className="diff-file">
            {f.path} <span className="muted small">({f.status})</span>
          </div>
          {f.hunks.map((h) => (
            <div key={h.n}>
              <div className="diff-hunk">{h.header}</div>
              {h.lines.map((l) => (
                <span
                  key={l.n}
                  className={`diff-line ${l.op === '+' ? 'diff-add' : l.op === '-' ? 'diff-del' : ''}`}
                >
                  <span aria-hidden="true">{l.op}</span>
                  <span className="visually-hidden">
                    {l.op === '+' ? 'added: ' : l.op === '-' ? 'removed: ' : ''}
                  </span>
                  {l.text}
                </span>
              ))}
            </div>
          ))}
        </section>
      ))}
    </>
  );
}

export function failedScanNames(e: Evidence): string {
  const scans = e.checks
    .filter((c) => ['secret_scan', 'sast', 'sca'].includes(c.kind) && c.status === 'fail')
    .map((c) => c.name.toLowerCase());
  return scans.length ? scans.join(' and ') : 'security scan';
}

/**
 * http(s) refs are links. fw:// refs have no web route in API v1 yet, so they
 * are shown as copyable text rather than a link that might not work.
 */
export function RefLink({ r, label, copy = true }: { r: string; label: string; copy?: boolean }) {
  if (/^https?:\/\//.test(r))
    return (
      <a className="small" href={r} target="_blank" rel="noreferrer">
        {label}
      </a>
    );
  return (
    <span className="small row" style={{ gap: 'var(--fw-space-1)' }}>
      <span className="mono" title={r}>
        {label}: {r.replace(/^fw:\/\//, '')}
      </span>
      {copy && <Copy text={r} label={label} />}
    </span>
  );
}
