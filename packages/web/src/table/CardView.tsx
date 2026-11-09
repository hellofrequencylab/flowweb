import { useState } from 'react';
import { ApiError, api, UnreachableError } from '../api/client';
import { useLive, useWriteBlock } from '../api/live';
import { useResource } from '../api/resource';
import type {
  AnswerCard,
  ApproveCard,
  ChooseCard,
  DecisionCard,
  ReasonCode,
  ReviewCard,
  UnblockCard,
} from '../api/types';
import { EvidenceView, failedScanNames, useDiff, useEvidence } from '../evidence/EvidenceView';
import { chordPending, useKeys } from '../shell/keys';
import { usePrefs } from '../shell/prefs';
import { Link } from '../shell/router';
import { Button } from '../ui-kit/Button';
import { focusOnMount } from '../ui-kit/focus';
import { LoadError, Loading, StaleNotice } from '../ui-kit/honest';
import { Icon } from '../ui-kit/Icon';
import { CHECK_STATUS, StatusLabel } from '../ui-kit/status';
import { age, clock, shortHash, usd, useNow, when } from '../ui-kit/time';
import { VARIANT_LABEL } from './TablePage';

export interface Decided {
  cardId: string;
  summary: string;
  at: string;
}

/** autonomy_tiers names from schema.core.sql. */
const TIER_NAME: Record<string, string> = {
  L0: 'Observe',
  L1: 'Draft',
  L2: 'Act in sandbox',
  L3: 'Act with approval',
  L4: 'Act with notification',
  L5: 'Autonomous',
};
const ASKED_BY: Record<string, string> = {
  verifier: 'Verifier',
  chief_of_staff: 'Chief of Staff',
  worker: 'Worker agent',
  system: 'fwd',
};
const REASONS: { code: ReasonCode; label: string }[] = [
  { code: 'wrong_approach', label: 'Wrong approach' },
  { code: 'not_now', label: 'Not now' },
  { code: 'too_risky', label: 'Too risky' },
  { code: 'needs_test', label: 'Needs a test' },
  { code: 'other', label: 'Other' },
];

type Mode = 'idle' | 'deny' | 'snooze' | 'sending';

export function CardView({
  id,
  showEvidence,
  onToggleEvidence,
  onDecided,
}: {
  id: string;
  showEvidence: boolean;
  onToggleEvidence: () => void;
  onDecided: (d: Decided) => void;
}) {
  const res = useResource(`card:${id}`, () => api.card(id), ['cards']);
  const card = res.data?.card;
  const bundleId = card?.variant === 'approve' ? card.evidence_bundle_id : card?.evidence_bundle_id;
  const ev = useEvidence(bundleId);
  const diff = useDiff(card?.variant === 'approve' ? bundleId : undefined);

  return (
    <>
      <article className="request" aria-labelledby="card-heading">
        {res.honesty === 'loading' && <Loading what="the card" />}
        {!card && res.honesty !== 'loading' && (
          <LoadError what="this card" error={res.error} onRetry={res.reload} />
        )}
        {card && res.honesty === 'stale' && <StaleNotice res={res} what="card" />}
        {card && (
          <CardBody
            card={card}
            current={res.honesty === 'current'}
            reload={res.reload}
            evidence={ev}
            diffHash={diff.data?.sha256}
            diffLoaded={diff.honesty === 'current'}
            showEvidence={showEvidence}
            onToggleEvidence={onToggleEvidence}
            onDecided={onDecided}
          />
        )}
      </article>
      {showEvidence && bundleId && (
        <aside className="evidence-col" aria-label="Evidence for this card">
          <EvidenceView
            ev={ev}
            diff={diff}
            payloadHash={card?.variant === 'approve' ? card.payload_preview.payload_hash : undefined}
          />
        </aside>
      )}
    </>
  );
}

function CardBody({
  card,
  current,
  reload,
  evidence,
  diffHash,
  diffLoaded,
  showEvidence,
  onToggleEvidence,
  onDecided,
}: {
  card: DecisionCard;
  current: boolean;
  reload: () => void;
  evidence: ReturnType<typeof useEvidence>;
  diffHash?: string;
  diffLoaded: boolean;
  showEvidence: boolean;
  onToggleEvidence: () => void;
  onDecided: (d: Decided) => void;
}) {
  const now = useNow();
  const { prefs } = usePrefs();
  const { refreshStatus } = useLive();
  const block = useWriteBlock();
  const [mode, setMode] = useState<Mode>('idle');
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<string | null>(null);

  const open = card.state === 'open';

  /** Run a write and report the outcome only after fwd confirms it. */
  const send = async (fn: () => Promise<unknown>, summary: string) => {
    setMode('sending');
    setError(null);
    try {
      await fn();
      await refreshStatus();
      onDecided({ cardId: card.id, summary, at: new Date().toISOString() });
    } catch (e) {
      setMode('idle');
      if (e instanceof UnreachableError) setError("Can't reach fwd. Nothing was recorded.");
      else if (e instanceof ApiError && e.code === 'stale_hash') {
        setError('The change moved since you looked. Nothing was merged.');
        reload();
      } else if (e instanceof ApiError && e.code === 'kill_switch_engaged')
        setError('Everything is stopped. Release the kill switch first. Nothing was recorded.');
      else setError(`fwd refused: ${(e as Error).message}. Nothing was recorded.`);
    }
  };

  // Approve lock: the reason Approve is unavailable, or null when it is safe.
  let approveLock: string | null = null;
  if (card.variant === 'approve') {
    const e = evidence.data;
    if (block) approveLock = block;
    else if (!current) approveLock = 'This card is not current. Approve unlocks when fwd answers.';
    else if (evidence.honesty === 'loading')
      approveLock = 'Loading evidence. Approve unlocks when it is here.';
    else if (!e) approveLock = 'The evidence could not be loaded. Approve unlocks when it is here.';
    else if (evidence.honesty !== 'current')
      approveLock = 'The evidence is not current. Approve unlocks when it is.';
    else if (e.scan_red)
      approveLock = `A security scan failed: ${failedScanNames(e)}. This cannot be approved.`;
    else if (e.payload_hash !== card.payload_preview.payload_hash)
      approveLock = 'The evidence is for a different change. Approve stays locked.';
    else if (!diffLoaded) approveLock = 'Loading the diff. Approve unlocks when you can see the exact lines.';
    else if (diffHash && e.diff_hash && diffHash !== e.diff_hash)
      approveLock = 'The diff does not match its hash. This cannot be approved.';
  }
  const writeLock = block ?? (!current ? 'This card is not current.' : null);

  const approve = () =>
    card.variant === 'approve' &&
    !approveLock &&
    send(
      () =>
        api.respondApproval(card.approval_id, {
          decision: 'approved',
          payload_hash: card.payload_preview.payload_hash,
          head_sha: card.head_sha,
        }),
      `Approved: ${card.title}.`,
    );

  useKeys(
    {
      a: () => open && card.variant === 'approve' && mode === 'idle' && approve(),
      d: () =>
        open && (card.variant === 'approve' || card.variant === 'review') && !writeLock && setMode('deny'),
      s: () => !chordPending() && open && !writeLock && setMode('snooze'),
      escape: () => setMode((m) => (m === 'sending' ? m : 'idle')),
      '1': () => card.variant === 'choose' && setChoice(card.options[0]?.id ?? null),
      '2': () => card.variant === 'choose' && setChoice(card.options[1]?.id ?? null),
      '3': () => card.variant === 'choose' && setChoice(card.options[2]?.id ?? null),
      '4': () => card.variant === 'choose' && setChoice(card.options[3]?.id ?? null),
    },
    prefs.shortcuts && open,
  );

  return (
    <div className="request-body">
      {/* 1. Type and autonomy */}
      <p className="row small">
        <span className="request-reason">
          <span className="icon-tile">
            <Icon name="waiting" size={17} />
          </span>
          {VARIANT_LABEL[card.variant]}
        </span>
        {card.autonomy_tier ? (
          <span className="muted">
            {card.autonomy_tier} {TIER_NAME[card.autonomy_tier] ?? ''}
          </span>
        ) : (
          <span className="muted">Autonomy level: Unknown</span>
        )}
        <span className="spacer" />
        {bundleToggle(card) && (
          <Button variant="quiet" onClick={onToggleEvidence} shortcut="e" aria-expanded={showEvidence}>
            {showEvidence ? 'Hide evidence' : 'Show evidence'}
          </Button>
        )}
      </p>

      {/* 2. Origin */}
      <p className="small muted">
        {card.project_name ?? 'Project unknown'}
        {card.row_id && (
          <>
            {' · '}
            <Link to={`/ledger/lr_${card.row_id.replace(/-/g, '')}`}>{card.row_id}</Link>
          </>
        )}
        {' · asked by '}
        {card.asked_by ? ASKED_BY[card.asked_by] : 'Unknown'} {age(card.created_at, now)}
      </p>

      {/* 3. Headline */}
      <h2 id="card-heading" className="request-title" tabIndex={-1}>
        {card.variant === 'approve' ? card.headline : card.title}
      </h2>
      {card.variant !== 'approve' && <p>{card.ask}</p>}

      <Resolution card={card} />
      {card.state === 'stale' && card.variant === 'approve' && <StaleChange card={card} />}

      {card.variant === 'approve' && <ApproveFacts card={card} now={now} />}
      {card.variant !== 'approve' && (card.deadline_at || card.default_on_timeout) && (
        <p className="small">
          {card.deadline_at ? `Due ${when(card.deadline_at, now)}. ` : ''}If nobody answers:{' '}
          {card.default_on_timeout}.
        </p>
      )}

      {card.variant === 'approve' && <EvidenceSummary evidence={evidence} />}
      {card.variant === 'approve' && card.head_sha && (
        <p className="hash">
          Approving hash {shortHash(card.payload_preview.payload_hash)} on head {shortHash(card.head_sha)}
        </p>
      )}

      {card.variant === 'choose' && (
        <ChooseOptions card={card} choice={choice} setChoice={setChoice} disabled={!open} />
      )}
      {card.variant === 'answer' && open && (
        <AnswerForm
          card={card}
          lock={writeLock}
          busy={mode === 'sending'}
          onSend={(v, s) => send(() => api.answer(card.id, { value: v }), s)}
        />
      )}
      {card.variant === 'review' && <ReviewInfo card={card} />}
      {card.variant === 'unblock' && <UnblockInfo card={card} />}

      {error && (
        <p className="callout callout-warn" role="alert">
          {error}
        </p>
      )}

      {open && mode === 'deny' && (
        <DenyForm
          busy={false}
          onCancel={() => setMode('idle')}
          onDeny={(reason, comment, changes) =>
            card.variant === 'approve'
              ? send(
                  () =>
                    api.respondApproval(card.approval_id, {
                      decision: changes ? 'changes_requested' : 'denied',
                      payload_hash: card.payload_preview.payload_hash,
                      head_sha: card.head_sha,
                      reason_code: reason,
                      comment,
                    }),
                  `${changes ? 'Changes requested' : 'Denied'}: ${card.title}.`,
                )
              : send(
                  () => api.answer(card.id, { value: changes ? 'changes_requested' : 'rejected' }),
                  `${changes ? 'Changes requested' : 'Rejected'}: ${card.title}.`,
                )
          }
        />
      )}
      {open && mode === 'snooze' && (
        <SnoozeForm
          max={card.variant === 'approve' ? card.expires_at : undefined}
          onCancel={() => setMode('idle')}
          onSnooze={(until) =>
            send(() => api.snooze(card.id, until), `Snoozed until ${when(until)}: ${card.title}.`)
          }
        />
      )}

      {/* 8. Actions: at most three. Deny one side, Snooze middle, the positive action on the other side. */}
      {open && mode !== 'deny' && mode !== 'snooze' && (
        <div className="card-actions">
          {(card.variant === 'approve' || card.variant === 'review') && (
            <Button
              onClick={() => setMode('deny')}
              disabledReason={writeLock}
              shortcut="d"
              className="btn-big"
            >
              {card.variant === 'approve' ? 'Deny' : 'Request changes'}
            </Button>
          )}
          <Button onClick={() => setMode('snooze')} disabledReason={writeLock} shortcut="s">
            Snooze
          </Button>
          <span className="spacer" />
          {card.variant === 'approve' && (
            <Button
              variant="primary"
              onClick={approve}
              disabledReason={mode === 'sending' ? 'Approving. Waiting for fwd to confirm.' : approveLock}
              shortcut="a"
            >
              Approve
            </Button>
          )}
          {card.variant === 'choose' && (
            <Button
              variant="primary"
              disabledReason={
                mode === 'sending'
                  ? 'Sending. Waiting for fwd to confirm.'
                  : (writeLock ?? (choice ? null : 'Pick an option first. Nothing is pre-selected.'))
              }
              onClick={() =>
                choice &&
                send(
                  () => api.answer(card.id, { option_id: choice }),
                  `Chose "${card.options.find((o) => o.id === choice)?.label}": ${card.title}.`,
                )
              }
            >
              Choose
            </Button>
          )}
          {card.variant === 'review' && (
            <Button
              variant="primary"
              disabledReason={mode === 'sending' ? 'Sending.' : writeLock}
              onClick={() =>
                send(() => api.answer(card.id, { value: 'accepted' }), `Accepted: ${card.title}.`)
              }
            >
              Accept
            </Button>
          )}
          {card.variant === 'unblock' &&
            card.suggested_actions.slice(0, 2).map((a, i) => (
              <Button
                key={a.id}
                variant={i === 0 ? 'primary' : 'default'}
                disabledReason={mode === 'sending' ? 'Sending.' : writeLock}
                onClick={() =>
                  send(() => api.answer(card.id, { option_id: a.id }), `${a.label}: ${card.title}.`)
                }
              >
                {a.label}
              </Button>
            ))}
        </div>
      )}

      {/* 9. Why this reached you */}
      <p className="small muted">
        <strong>Why this reached you:</strong>{' '}
        {card.why ? (
          <>
            {card.why.text} <span className="mono">({card.why.rule_id})</span>
          </>
        ) : (
          'fwd has not reported which rule routed this card.'
        )}
      </p>
    </div>
  );
}

function bundleToggle(card: DecisionCard) {
  return Boolean(card.evidence_bundle_id);
}

function ApproveFacts({ card, now }: { card: ApproveCard; now: number }) {
  return (
    <>
      <dl className="facts">
        <dt>Blast radius</dt>
        <dd>{card.risk.blast_radius}</dd>
        <dt>Cost</dt>
        <dd>
          {card.cost_usd != null ? usd(card.cost_usd, true) : <span className="fact-unknown">Unknown</span>}
        </dd>
        <dt>Deadline</dt>
        <dd>
          {card.deadline_at
            ? `Expires ${when(card.deadline_at, now)}, default: ${card.default_on_timeout}`
            : `No deadline. Default: ${card.default_on_timeout}`}
        </dd>
        <dt>Merge slot</dt>
        <dd>
          {card.merge_slot == null ? (
            <span className="fact-unknown">Unknown</span>
          ) : card.merge_slot.held ? (
            `Slot held, expires ${clock(card.merge_slot.expires_at)}`
          ) : (
            'No slot held. One is requested after approval.'
          )}
        </dd>
        {card.pr && (
          <>
            <dt>Pull request</dt>
            <dd>
              <a href={card.pr.url} target="_blank" rel="noreferrer">
                PR {card.pr.number}
              </a>
            </dd>
          </>
        )}
      </dl>
      {card.files && card.files.length > 0 && (
        <div>
          <h3 className="h-line">Preview: {card.files.length} files</h3>
          <ul className="plain-list small">
            {card.files.map((f) => (
              <li key={f.path} className="row">
                <span className="mono">{f.path}</span>
                <span className="spacer" />
                <span className="mono">
                  <span aria-hidden="true">
                    +{f.added} −{f.removed}
                  </span>
                  <span className="visually-hidden">
                    {f.added} lines added, {f.removed} removed
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function EvidenceSummary({ evidence }: { evidence: ReturnType<typeof useEvidence> }) {
  const e = evidence.data;
  return (
    <div>
      <h3 className="h-line">Evidence</h3>
      {!e && evidence.honesty === 'loading' && (
        <StatusLabel spec={CHECK_STATUS.pending} detail="evidence loading" />
      )}
      {!e && evidence.honesty !== 'loading' && (
        <p className="row">
          <StatusLabel spec={{ word: 'Evidence could not be loaded', tone: 'warn', icon: 'warn' }} />
          <button type="button" className="btn btn-quiet" onClick={evidence.reload}>
            Retry
          </button>
        </p>
      )}
      {e && (
        <ul className="plain-list small">
          {e.checks.map((c) => (
            <li key={c.name} className="row">
              <span style={{ minWidth: '10rem' }}>{c.name}</span>
              <StatusLabel spec={CHECK_STATUS[c.status]} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StaleChange({ card }: { card: ApproveCard }) {
  return (
    <div className="callout callout-warn" role="alert">
      <p>
        <strong>Changed while you were looking.</strong> The agent pushed new code. Nothing was merged.
      </p>
      <p className="hash">
        You were shown {shortHash(card.head_sha ?? '')}. The pull request is now at{' '}
        {shortHash(card.current_head_sha ?? '')}.
      </p>
      {card.replacement_card_id ? (
        <Link to={`/table/${card.replacement_card_id}`} className="btn">
          Open the new request
        </Link>
      ) : (
        <p className="small">
          A new request will appear on the table when fwd has collected evidence for the new code.
        </p>
      )}
    </div>
  );
}

function Resolution({ card }: { card: DecisionCard }) {
  const r = card.resolution;
  switch (card.state) {
    case 'approved':
      return (
        <p className="callout">
          <Icon name="pass" /> Approved {r ? `at ${clock(r.at)}` : ''}. Recorded.
        </p>
      );
    case 'denied':
      return (
        <p className="callout">
          Denied {r ? `at ${clock(r.at)}` : ''}
          {r?.reason ? ` (${r.reason.replace(/_/g, ' ')})` : ''}. Recorded.
        </p>
      );
    case 'answered':
      return <p className="callout">Answered {r ? `at ${clock(r.at)}: ${r.decision}` : ''}. Recorded.</p>;
    case 'expired':
      return (
        <p className="callout">
          Expired at {clock(card.deadline_at)}.{' '}
          {card.default_on_timeout === 'deny' ? 'Denied' : card.default_on_timeout} by default
          {r?.by === 'system' ? ', applied by fwd' : ''}.
        </p>
      );
    case 'withdrawn':
      return <p className="callout">Withdrawn {r ? `at ${clock(r.at)}` : ''}. Nothing needs you here.</p>;
    case 'snoozed':
      return <p className="callout">Snoozed until {when(card.snoozed_until)}.</p>;
    default:
      return null;
  }
}

function ChooseOptions({
  card,
  choice,
  setChoice,
  disabled,
}: {
  card: ChooseCard;
  choice: string | null;
  setChoice: (c: string) => void;
  disabled: boolean;
}) {
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="visually-hidden">Options</legend>
      {card.options.map((o, i) => (
        <label key={o.id} className="option">
          <span className="row">
            <input
              type="radio"
              name={`opt-${card.id}`}
              value={o.id}
              checked={choice === o.id}
              onChange={() => setChoice(o.id)}
              disabled={disabled}
            />
            <strong>{o.label}</strong>
            <span className="kbd" aria-hidden="true">
              {i + 1}
            </span>
            {o.id === card.recommended_option && <span className="chip">Recommended</span>}
          </span>
          <span className="small">{o.consequence}</span>
          <br />
          <span className="xs muted">
            {o.cost_usd !== undefined ? `Cost ${usd(o.cost_usd, true)}` : 'Cost unknown'} ·{' '}
            {o.reversible === undefined
              ? 'Undo: unknown'
              : o.reversible
                ? 'Can be undone'
                : 'Cannot be undone'}
          </span>
          {o.id === card.recommended_option && (
            <span className="small" style={{ display: 'block' }}>
              Why recommended: {card.recommendation_reason}
            </span>
          )}
        </label>
      ))}
    </fieldset>
  );
}

function AnswerForm({
  card,
  lock,
  busy,
  onSend,
}: {
  card: AnswerCard;
  lock: string | null;
  busy: boolean;
  onSend: (v: string | number | boolean | null, summary: string) => void;
}) {
  const [v, setV] = useState('');
  const inputType = card.answer_type === 'number' ? 'number' : card.answer_type === 'date' ? 'date' : 'text';
  return (
    <div className="stack">
      <p>
        <strong>{card.question}</strong>
      </p>
      {card.basis_gap && <p className="small muted">Why you: {card.basis_gap}</p>}
      {card.answer_type === 'yes_no' ? (
        <div className="row">
          <Button disabledReason={lock} onClick={() => onSend(true, `Answered yes: ${card.title}.`)}>
            Yes
          </Button>
          <Button disabledReason={lock} onClick={() => onSend(false, `Answered no: ${card.title}.`)}>
            No
          </Button>
        </div>
      ) : card.answer_type === 'choice' ? (
        <select value={v} onChange={(e) => setV(e.target.value)} aria-label="Your answer">
          <option value="">Pick one</option>
          {card.constraints?.choices?.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      ) : (
        <label>
          <span className="visually-hidden">Your answer</span>
          <input
            type={inputType}
            value={v}
            onChange={(e) => setV(e.target.value)}
            min={card.constraints?.min}
            max={card.constraints?.max}
            maxLength={card.constraints?.max_length}
            style={{ width: '100%' }}
          />
        </label>
      )}
      <div className="row">
        {card.answer_type !== 'yes_no' && (
          <Button
            variant="primary"
            disabledReason={busy ? 'Sending.' : (lock ?? (v.trim() ? null : 'Type an answer first.'))}
            onClick={() => onSend(card.answer_type === 'number' ? Number(v) : v, `Answered: ${card.title}.`)}
          >
            Answer
          </Button>
        )}
        {card.suggested_answer && (
          <Button
            disabledReason={lock}
            onClick={() => onSend(card.suggested_answer!, `Used the default: ${card.title}.`)}
          >
            Use the default: {card.suggested_answer}
          </Button>
        )}
        <Button
          variant="quiet"
          disabledReason={lock}
          onClick={() => onSend(null, `Marked "I don't know yet": ${card.title}.`)}
        >
          I don't know yet
        </Button>
      </div>
    </div>
  );
}

function ReviewInfo({ card }: { card: ReviewCard }) {
  return (
    <div className="stack">
      <p>
        Artifact:{' '}
        {/^https?:/.test(card.artifact.ref) ? (
          <a href={card.artifact.ref}>{card.artifact.title ?? card.artifact.ref}</a>
        ) : (
          <span className="mono">{card.artifact.ref}</span>
        )}
      </p>
      {card.verifier_summary && (
        <p>
          <span className="muted">Verifier (advice, not a gate):</span> {card.verifier_summary}
        </p>
      )}
    </div>
  );
}

function UnblockInfo({ card }: { card: UnblockCard }) {
  return (
    <div className="stack">
      <p className="row">
        <StatusLabel spec={{ word: 'Blocked', tone: 'warn', icon: 'blocked' }} />
        <span>{card.blocker.description}</span>
      </p>
      <p className="small muted">Blocked since {when(card.blocker.since)}.</p>
      <ul className="small">
        {card.suggested_actions.map((a) => (
          <li key={a.id}>
            <strong>{a.label}</strong>
            {a.consequence ? `: ${a.consequence}` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

function DenyForm({
  onCancel,
  onDeny,
}: {
  busy: boolean;
  onCancel: () => void;
  onDeny: (r: ReasonCode, comment: string, changes: boolean) => void;
}) {
  const [reason, setReason] = useState<ReasonCode | null>(null);
  const [comment, setComment] = useState('');
  return (
    <form
      className="panel stack"
      onSubmit={(e) => {
        e.preventDefault();
      }}
      aria-label="Deny"
    >
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend>
          <strong>Why?</strong> <span className="muted small">One line is enough.</span>
        </legend>
        <div className="row">
          {REASONS.map((r) => (
            <label key={r.code} className="chip" style={{ minHeight: 'var(--fw-target)', cursor: 'pointer' }}>
              <input
                type="radio"
                name="reason"
                checked={reason === r.code}
                onChange={() => setReason(r.code)}
              />{' '}
              {r.label}
            </label>
          ))}
        </div>
      </fieldset>
      <label>
        <span className="small">Note for the agent (optional)</span>
        <input
          type="text"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          style={{ width: '100%' }}
          maxLength={240}
          ref={focusOnMount}
        />
      </label>
      <div className="row">
        <Button
          disabledReason={reason ? null : 'Pick a reason first.'}
          onClick={() => reason && onDeny(reason, comment, false)}
          className="btn-big"
        >
          Deny
        </Button>
        <Button
          disabledReason={reason ? null : 'Pick a reason first.'}
          onClick={() => reason && onDeny(reason, comment, true)}
        >
          Request changes instead
        </Button>
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function SnoozeForm({
  max,
  onCancel,
  onSnooze,
}: {
  max?: string;
  onCancel: () => void;
  onSnooze: (until: string) => void;
}) {
  const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  const tomorrow9 = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  };
  const cap = (iso: string) => (max && iso > max ? max : iso);
  const opts = [
    { label: '1 hour', until: cap(at(1)) },
    { label: '3 hours', until: cap(at(3)) },
    { label: 'Tomorrow 09:00', until: cap(tomorrow9()) },
  ];
  return (
    <section className="panel stack" aria-label="Snooze">
      <p>
        <strong>Snooze until</strong>
        {max && <span className="small muted"> (no later than the deadline, {when(max)})</span>}
      </p>
      <div className="row">
        {opts.map((o) => (
          <button type="button" key={o.label} className="btn" onClick={() => onSnooze(o.until)}>
            {o.label}
            {o.until === max ? ' (deadline)' : ''}
          </button>
        ))}
        <button type="button" className="btn btn-quiet" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
