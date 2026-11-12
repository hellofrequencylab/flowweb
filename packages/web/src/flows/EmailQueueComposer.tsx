import { type FormEvent, useState } from 'react';
import { api } from '../api/client';
import type { FlowDraft } from '../api/types';
import { Icon } from '../ui-kit/Icon';

/** Stages opted-in email copy for review and pasting into Frequency Email Studio. */
export function EmailQueueComposer({ onStaged }: { onStaged: (draftId: string) => void }) {
  const [asset, setAsset] = useState('');
  const [subject, setSubject] = useState('');
  const [preheader, setPreheader] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'fail'; text: string } | null>(null);

  async function stage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setQueued(false);
    setMessage(null);
    try {
      const result: { draft: FlowDraft } = await api.stageEmailDraft(
        {
          asset: asset.trim(),
          subject: subject.trim(),
          ...(preheader.trim() ? { preheader: preheader.trim() } : {}),
          body: body.trim(),
          audience: 'subscribed_members',
        },
        () => setQueued(true),
      );
      const blocked = result.draft.gate?.blocks?.length ?? 0;
      setMessage({
        tone: 'ok',
        text: blocked
          ? 'Staged for review. The saved draft is blocked by its facts check.'
          : 'Staged for review in the Email Studio drafts inbox.',
      });
      setAsset('');
      setSubject('');
      setPreheader('');
      setBody('');
      onStaged(result.draft.id);
    } catch (error) {
      setMessage({ tone: 'fail', text: (error as Error).message });
    } finally {
      setBusy(false);
      setQueued(false);
    }
  }

  return (
    <form
      className="draft-ai email-queue-composer"
      aria-labelledby="email-queue-composer-title"
      onSubmit={stage}
    >
      <h3 id="email-queue-composer-title">Stage an email for Email Studio</h3>
      <p className="muted">
        Draft only. This saves copy for the Email Studio drafts inbox. It does not send or schedule anything.
      </p>
      <div className="draft-fields">
        <label className="field">
          <span className="field-label">Draft name</span>
          <input
            name="asset"
            autoComplete="off"
            required
            value={asset}
            onChange={(event) => setAsset(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Subject</span>
          <input
            name="subject"
            autoComplete="off"
            required
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">
            Preheader <span className="muted">(optional)</span>
          </span>
          <input
            name="preheader"
            autoComplete="off"
            value={preheader}
            onChange={(event) => setPreheader(event.target.value)}
          />
        </label>
        <label className="field">
          <span className="field-label">Email copy</span>
          <textarea
            name="body"
            rows={14}
            required
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        <div className="field">
          <span className="field-label">Audience</span>
          <p className="email-queue-audience">Subscribed members only</p>
        </div>
      </div>
      <button
        className="btn btn-primary"
        type="submit"
        disabled={busy || !asset.trim() || !subject.trim() || !body.trim()}
      >
        <Icon name="copy" size={15} /> {busy ? 'Staging draft…' : 'Stage draft for Email Studio'}
      </button>
      {busy && (
        <p className="muted draft-status" role="status">
          {queued ? 'Waiting for your paired Mac to stage this draft.' : 'Staging this draft for review.'}
        </p>
      )}
      {message && (
        <p
          className={message.tone === 'fail' ? 'draft-note-fail' : 'muted draft-status'}
          role={message.tone === 'fail' ? 'alert' : 'status'}
        >
          {message.text}
        </p>
      )}
    </form>
  );
}
