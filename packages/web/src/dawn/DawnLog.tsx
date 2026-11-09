import { api } from '../api/client';
import { useLive, useStatusResource } from '../api/live';
import { useResource } from '../api/resource';
import type { DawnLog as Dawn, Status } from '../api/types';
import { CargoLanded } from '../rewards/Rewards';
import { usePrefs } from '../shell/prefs';
import { Link } from '../shell/router';
import { AsOf, Fact, LoadError, Loading, StaleNotice } from '../ui-kit/honest';
import { Icon } from '../ui-kit/Icon';
import { PROBE_STATUS, StatusLabel } from '../ui-kit/status';
import { age, clock, usd, useNow, when } from '../ui-kit/time';

/** Home. In under a minute: what happened, what needs you, whether anything is stopped or wrong. */
export function DawnLog() {
  const dawn = useResource('dawn', api.dawn, ['dawn', 'rows', 'runs']);
  const st = useStatusResource();
  const { connection } = useLive();
  const now = useNow();
  const s = st.data;
  const d = dawn.data;
  const { prefs } = usePrefs();
  const rewards = prefs.rewards && prefs.rewardCargoLanded;

  return (
    <>
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h1 tabIndex={-1}>Dawn Log</h1>
        <span className="spacer" />
        {d?.digest?.self_check_ok && <span className="asof">Digest {clock(d.digest.produced_at)}</span>}
        <AsOf res={dawn} label="Live counts as of" />
      </div>

      <Problems status={s} down={connection === 'down'} />

      {dawn.honesty === 'loading' && <Loading what="today's log" />}
      {!d && dawn.honesty !== 'loading' && (
        <LoadError what="today's log" error={dawn.error} onRetry={dawn.reload} />
      )}
      {d && dawn.honesty === 'stale' && <StaleNotice res={dawn} what="log" />}

      {d && (
        <>
          <DigestNote d={d} />
          <p style={{ fontSize: 'var(--fw-text-lg)' }}>
            <Summary d={d} s={s} honest={dawn.honesty === 'current' && st.honesty === 'current'} />
          </p>

          {isQuiet(d, s) && dawn.honesty === 'current' ? (
            <p className="callout">
              Nothing changed since {clock(d.since)}. Checked: ledger, runs, spend, decision cards.
            </p>
          ) : null}

          <ul className="plain-list">
            <li>
              <h2 className="h-line">Needs you</h2>
              <Fact
                res={st}
                pick={(x: Status) => x.cards_open}
                format={(n) =>
                  n === 0 ? (
                    <span>
                      Nothing is waiting. <span className="muted small">Checked {clock(s?.data_as_of)}.</span>
                    </span>
                  ) : (
                    <span>
                      <Link to="/table" className="status status-attention">
                        <Icon name="waiting" /> {n} card{n === 1 ? '' : 's'} waiting
                      </Link>
                      {s?.oldest_card_created_at && (
                        <span className="muted">
                          {' '}
                          · oldest waited {age(s.oldest_card_created_at, now).replace(' ago', '')}
                        </span>
                      )}
                    </span>
                  )
                }
              />
            </li>

            <li>
              <h2 className="h-line">Landed since {when(d.since, now)}</h2>
              {d.rows_done.length === 0 ? (
                <p className="muted">No rows reached Done. Checked the ledger at {clock(d.data_as_of)}.</p>
              ) : (
                <ul className="plain-list">
                  {d.rows_done.map((r) => (
                    <li key={r.ledger_row_id} className="row">
                      <StatusLabel spec={{ word: 'Done', tone: 'ok', icon: 'pass' }} />
                      <Link to={`/ledger/${r.ledger_row_id}`}>
                        {r.row_id} {r.title}
                      </Link>
                      <span className="muted small">
                        merged <span className="mono">{r.merged_sha.slice(0, 7) || 'unknown'}</span>
                      </span>
                      <Link to={`/ledger/${r.ledger_row_id}#probe`} className="small">
                        Probe {PROBE_STATUS[r.probe_status].word.toLowerCase()}{' '}
                        {r.probe_at ? clock(r.probe_at) : ''}
                      </Link>
                      {rewards && r.probe_status === 'pass' && r.merged_sha && (
                        <CargoLanded
                          rowId={r.row_id}
                          ledgerRowId={r.ledger_row_id}
                          title={r.title}
                          sha={r.merged_sha}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {d.rows_watching.length > 0 && (
                <>
                  <h3 style={{ marginTop: 'var(--fw-space-4)' }}>Merged, watching</h3>
                  <ul className="plain-list">
                    {d.rows_watching.map((r) => (
                      <li key={r.ledger_row_id} className="row">
                        <StatusLabel spec={{ word: 'Not verified', tone: 'unknown', icon: 'notverified' }} />
                        <Link to={`/ledger/${r.ledger_row_id}`}>
                          {r.row_id} {r.title}
                        </Link>
                        <span className="muted small">Probe has not passed on the merged code yet.</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </li>

            <li>
              <h2 className="h-line">Runs since {when(d.since, now)}</h2>
              <p className="row">
                <Link to="/runs?status=succeeded">{d.runs.succeeded} succeeded</Link>
                <Link to="/runs?status=failed">{d.runs.failed} failed</Link>
                <Link to="/runs?status=halted">{d.runs.halted} halted</Link>
                <span className="muted small">of {d.runs.total} finished</span>
              </p>
            </li>

            <li>
              <h2 className="h-line">Spend today</h2>
              <Fact
                res={st}
                pick={(x: Status) => x.spend_today}
                format={(sp) => (
                  <span>
                    <Link to="/spend">
                      {usd(sp.usd, sp.estimated)} of {usd(sp.cap_usd)}
                    </Link>
                    {sp.vendors_configured && sp.vendors_reporting.length < sp.vendors_configured.length && (
                      <span className="muted small">
                        {' '}
                        · partial: {sp.vendors_reporting.length} of {sp.vendors_configured.length} vendors
                        reporting
                      </span>
                    )}
                  </span>
                )}
              />
            </li>

            <li>
              <h2 className="h-line">Integrity</h2>
              <Fact
                res={st}
                pick={(x: Status) => x.integrity}
                format={(i) =>
                  i.ok ? (
                    <span>
                      Event log verified up to #{i.verified_up_to_seq} at {clock(i.checked_at)}.
                    </span>
                  ) : (
                    <StatusLabel
                      spec={{
                        word: `Event log failed its integrity check at #${i.failed_at_seq ?? '?'}`,
                        tone: 'fail',
                        icon: 'fail',
                      }}
                    />
                  )
                }
              />
            </li>
          </ul>
        </>
      )}
    </>
  );
}

function isQuiet(d: Dawn, s: Status | null) {
  return (
    d.rows_done.length === 0 &&
    d.rows_watching.length === 0 &&
    d.runs.total === 0 &&
    (s?.cards_open ?? 0) === 0
  );
}

function DigestNote({ d }: { d: Dawn }) {
  if (!d.digest) return <p className="small muted">No digest yet for today. Showing live counts.</p>;
  if (!d.digest.self_check_ok)
    return (
      <p className="callout callout-warn" role="status">
        Today's digest failed its own check. Showing live counts instead.
      </p>
    );
  return null;
}

function Summary({ d, s, honest }: { d: Dawn; s: Status | null; honest: boolean }) {
  if (!honest) return <span>Summary unknown until fwd answers.</span>;
  const parts = [
    `${d.rows_done.length} row${d.rows_done.length === 1 ? '' : 's'} done since ${when(d.since)}.`,
  ];
  if (s)
    parts.push(
      s.cards_open === 0
        ? 'Nothing needs you.'
        : `${s.cards_open} card${s.cards_open === 1 ? '' : 's'} need${s.cards_open === 1 ? 's' : ''} you.`,
    );
  if (s?.spend_today) parts.push(`Spend ${usd(s.spend_today.usd)} of ${usd(s.spend_today.cap_usd)}.`);
  return <span>{parts.join(' ')}</span>;
}

/** Problems line: only when something is wrong, first thing on the page. */
function Problems({ status: s, down }: { status: Status | null; down: boolean }) {
  const items: string[] = [];
  if (down) items.push("Can't reach fwd. Every value below is Unknown.");
  if (s?.kill_switch.state === 'stopped')
    items.push(`Kill switch engaged at ${clock(s.kill_switch.engaged_at)}.`);
  if (s?.kill_switch.state === 'stopping') items.push('Kill switch: stopping, not yet confirmed.');
  if (s?.breaker?.tripped) items.push(`Budget breaker tripped: ${s.breaker.reason ?? 'no reason given'}.`);
  else if (s?.paused_by_budget) items.push('Paused: daily budget reached.');
  if (s && !s.integrity.ok)
    items.push(
      `Event log integrity check failed${s.integrity.failed_at_seq ? ` at #${s.integrity.failed_at_seq}` : ''}.`,
    );
  if (s && s.sandbox_egress !== 'enforced')
    items.push(
      `Sandbox not fully enforced (egress ${s.sandbox_egress === 'best_effort' ? 'best effort' : 'none'}).`,
    );
  if (items.length === 0) return null;
  return (
    <div className="callout callout-fail" role="alert" style={{ marginBottom: 'var(--fw-space-4)' }}>
      <strong>Problems</strong>
      <ul style={{ margin: 'var(--fw-space-2) 0 0', paddingLeft: 'var(--fw-space-5)' }}>
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}
