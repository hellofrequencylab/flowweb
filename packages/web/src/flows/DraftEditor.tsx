import { useState } from 'react';
import { api } from '../api/client';
import type { FlowDraft } from '../api/types';
import { Button } from '../ui-kit/Button';
import { Icon } from '../ui-kit/Icon';
import { DraftAssistant } from './DraftAssistant';

type Mode = 'view' | 'edit';

/**
 * One draft: read it, copy it, change it by hand or with the AI assistant (DraftAssistant, FW-C-076),
 * approve it (at Copilot) or reject it.
 * Nothing here sends anything. On the live site each change is applied on your Mac.
 */
export function DraftEditor({
  flow,
  draft,
  onChanged,
}: {
  flow: string;
  draft: FlowDraft;
  onChanged: () => void;
}) {
  const locked = draft.status === 'handed_off';
  const [mode, setMode] = useState<Mode>('view');
  const [subject, setSubject] = useState(draft.subject ?? '');
  const [body, setBody] = useState(draft.body);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'fail'; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const start = () => {
    setSubject(draft.subject ?? '');
    setBody(draft.body);
    setNote(null);
    setMode('edit');
  };

  async function act<T>(label: string, run: (queued: () => void) => Promise<T>, done: (r: T) => void) {
    setBusy(label);
    setNote(null);
    try {
      done(await run(() => setBusy(`${label} Waiting for your Mac to apply it.`)));
    } catch (e) {
      setNote({ tone: 'fail', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const save = () =>
    act(
      'Saving.',
      (q) => api.draftChange(flow, draft.id, 'edit', { subject, body }, q),
      () => {
        setMode('view');
        setNote({ tone: 'ok', text: 'Saved.' });
        onChanged();
      },
    );

  // FW-C-062: approving hands the draft to the outbox for a sending app. FlowWeb itself sends nothing,
  // and fwd refuses it at Draft, for a template, or for a channel the flow does not use.
  const approve = () =>
    act(
      'Approving.',
      (q) => api.draftChange(flow, draft.id, 'approve', {}, q),
      () => {
        setNote({ tone: 'ok', text: 'Approved. It is in the outbox for your sending app.' });
        onChanged();
      },
    );
  const canApprove =
    draft.status === 'waiting_for_owner' && !(draft.lead_id ?? '').startsWith('template:') && mode === 'view';

  const reject = () =>
    act(
      'Rejecting.',
      (q) => api.draftChange(flow, draft.id, 'reject', {}, q),
      () => onChanged(),
    );

  const mark = (outcome: 'sent' | 'replied' | 'declined', label: string) =>
    act(
      label,
      (q) => api.draftChange(flow, draft.id, 'mark', { outcome }, q),
      () => onChanged(),
    );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${draft.subject ? `${draft.subject}\n\n` : ''}${draft.body}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setNote({ tone: 'fail', text: 'Your browser did not allow copying. Select the text instead.' });
    }
  };

  const why = busy ?? (locked ? 'This draft is already in the outbox.' : null);
  return (
    <div className="draft-editor">
      {mode === 'view' ? (
        <pre className="draft-body">{draft.body}</pre>
      ) : (
        <>
          <label className="field">
            <span className="field-label">Subject</span>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={20000}
            />
          </label>
          <label className="field">
            <span className="field-label">Message</span>
            <textarea rows={16} value={body} onChange={(e) => setBody(e.target.value)} maxLength={20000} />
          </label>
        </>
      )}

      <div className="draft-actions">
        {mode === 'view' ? (
          <>
            <Button onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
            <Button onClick={start} disabledReason={why}>
              Edit
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="primary"
              onClick={save}
              disabledReason={busy ?? (body.trim() ? null : 'The message cannot be empty.')}
            >
              Save
            </Button>
            <Button variant="quiet" onClick={() => setMode('view')} disabledReason={busy}>
              Cancel
            </Button>
          </>
        )}
        {canApprove && (
          <Button onClick={approve} disabledReason={why} title="Needs the flow at Copilot">
            Approve
          </Button>
        )}
        {draft.status !== 'rejected' && (
          <Button variant="quiet" onClick={reject} disabledReason={why}>
            Reject
          </Button>
        )}
      </div>

      {!locked && (
        <DraftAssistant
          flow={flow}
          draft={draft}
          current={mode === 'edit' ? { subject, body } : { subject: draft.subject ?? '', body: draft.body }}
          blocked={busy}
          onText={(t) => {
            setSubject(t.subject);
            setBody(t.body);
            setNote(null);
            setMode('edit');
          }}
        />
      )}

      {draft.status !== 'rejected' && (
        <div className="draft-ai draft-after">
          <span className="field-label">
            <Icon name="send" /> After you send it
          </span>
          <div className="draft-actions">
            {!draft.sent_at && (
              <Button
                className="btn-small"
                onClick={() => mark('sent', 'Marking it sent.')}
                disabledReason={busy}
              >
                I sent it
              </Button>
            )}
            {!draft.replied_at && !draft.declined_at && (
              <Button
                className="btn-small"
                onClick={() => mark('replied', 'Marking that they replied.')}
                disabledReason={busy}
              >
                They replied
              </Button>
            )}
            {!draft.declined_at && (
              <Button
                className="btn-small"
                variant="quiet"
                onClick={() => {
                  if (window.confirm('Mark that they said no? They go on this flow’s do-not-contact list.'))
                    mark('declined', 'Marking that they said no.');
                }}
                disabledReason={busy}
              >
                They said no
              </Button>
            )}
          </div>
          <p className="muted draft-ai-hint">
            This only records what happened, so the flow learns. Nothing is sent.
          </p>
        </div>
      )}

      {busy && (
        <p className="muted" role="status">
          {busy}
        </p>
      )}
      {note && (
        <p
          className={note.tone === 'fail' ? 'draft-note-fail' : 'muted'}
          role={note.tone === 'fail' ? 'alert' : 'status'}
        >
          {note.text}
        </p>
      )}
    </div>
  );
}
