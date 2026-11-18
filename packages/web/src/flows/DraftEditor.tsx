import { useState } from 'react';
import { api } from '../api/client';
import type { FlowDraft } from '../api/types';
import { Button } from '../ui-kit/Button';
import { Icon } from '../ui-kit/Icon';
import { DraftAssistant } from './DraftAssistant';
import { draftHtml, LOGO_URL, splitSignOff } from './draft-html';

type Mode = 'view' | 'edit';

/**
 * One draft: read it, copy it, change it by hand or with the AI assistant (DraftAssistant, FW-C-076),
 * approve it (at Copilot) or reject it.
 * Nothing here sends anything. On the live site each change is applied on your Mac.
 */
export function DraftEditor({
  flow,
  draft,
  sender = false,
  onChanged,
  onSent,
}: {
  flow: string;
  draft: FlowDraft;
  /** FW-C-071: a sender on the Mac reads the outbox. Without one, Approve becomes Copy and send. */
  sender?: boolean;
  onChanged: () => void;
  /** FW-C-163: called once the draft is marked sent, so the inbox can open the next one. */
  onSent?: () => void;
}) {
  const locked = draft.status === 'handed_off';
  const emailQueue = flow === 'email-queue';
  const [mode, setMode] = useState<Mode>('view');
  const [subject, setSubject] = useState(draft.subject ?? '');
  const [body, setBody] = useState(draft.body);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'fail'; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  // FW-C-163: after Copy and send, the draft asks whether it went, so marking it is one tap.
  const [asking, setAsking] = useState(false);
  // The same message as a plain link, shown after the press in case the browser blocked the new tab.
  const [mailLink, setMailLink] = useState<string | null>(null);
  const [mail, setMail] = useState<MailApp>(readMailApp);
  const to = mailAddress(draft);

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
      () => {
        setAsking(false);
        if (outcome === 'sent') onSent?.();
        onChanged();
      },
    );

  const copy = async () => {
    try {
      const text = emailQueue
        ? [
            draft.subject ? `Subject: ${draft.subject}` : null,
            draft.preheader ? `Preheader: ${draft.preheader}` : null,
            draft.body,
          ]
            .filter(Boolean)
            .join('\n\n')
        : `${draft.subject ? `${draft.subject}\n\n` : ''}${draft.body}`;
      // FW-C-089: an HTML twin carries the Frequency logo above the sign-off, so it pastes into Gmail.
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob([text], { type: 'text/plain' }),
            'text/html': new Blob([draftHtml(text)], { type: 'text/html' }),
          }),
        ]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      return true;
    } catch {
      setNote({ tone: 'fail', text: 'Your browser did not allow copying. Select the text instead.' });
      return false;
    }
  };
  // FW-C-071: with no sender to read the outbox, the Owner sends it from his own mail.
  // FW-C-163: with an address, the same press also starts the message in the Owner's own mail, filled in.
  // He still presses send there; FlowWeb sends nothing.
  const copyToSend = async () => {
    // The copy starts and the message opens inside the press itself. Opening it only after the copy
    // finished let the browser treat it as a pop-up and block it without a word.
    const copying = copy();
    const url = to ? composeUrl(mail, to, draft.subject ?? '', draft.body) : null;
    if (url) {
      try {
        window.open(url, '_blank', 'noopener');
      } catch {
        // A blocked pop-up leaves the link below, and the copied text, as the way to send.
      }
    }
    setMailLink(url);
    const ok = await copying;
    if (!ok && !to) return;
    setNote({
      tone: 'ok',
      text: to
        ? `Opened a new message to ${to} in ${MAIL_NAME[mail]}${ok ? ', and copied it too' : ''}. Press send there.`
        : 'Copied. Send it from your own mail, then press Yes, I sent it.',
    });
    if (!draft.sent_at) setAsking(true);
  };
  const pickMail = (m: MailApp) => {
    setMail(m);
    try {
      localStorage.setItem(MAIL_PREF, m);
    } catch {
      // Private windows may refuse storage; the choice then lasts for this page.
    }
  };

  const why = busy ?? (locked ? 'This draft is already in the outbox.' : null);
  return (
    <div className="draft-editor">
      <div
        className="draft-toolbar"
        role="toolbar"
        aria-label={emailQueue ? 'Email template actions' : 'Draft actions'}
      >
        <div className="draft-toolbar-group">
          {emailQueue ? (
            <Button onClick={copy}>
              <Icon name={copied ? 'check' : 'copy'} size={15} />
              {copied ? 'Copied for Email Studio' : 'Copy for Email Studio'}
            </Button>
          ) : mode === 'view' ? (
            <>
              <Button onClick={copy}>
                <Icon name={copied ? 'check' : 'copy'} size={15} /> {copied ? 'Copied' : 'Copy'}
              </Button>
              <Button onClick={start} disabledReason={why}>
                <Icon name="pencil" size={15} /> Edit
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
        </div>
        {!emailQueue && (
          <div className="draft-toolbar-group draft-toolbar-end">
            {canApprove && sender && (
              <Button
                variant="primary"
                onClick={approve}
                disabledReason={why}
                title="Needs the flow at Copilot"
              >
                Approve
              </Button>
            )}
            {canApprove && !sender && (
              <Button
                variant="primary"
                onClick={copyToSend}
                title="No sender on your Mac reads the outbox, so you send this one"
              >
                Copy and send
              </Button>
            )}
            {draft.status !== 'rejected' && (
              <Button variant="quiet" onClick={reject} disabledReason={why}>
                Reject
              </Button>
            )}
          </div>
        )}
      </div>

      {canApprove && !sender && to && (
        <p className="muted draft-status draft-mail-pick">
          Copy and send opens a new message to {to} in{' '}
          <select aria-label="Mail app" value={mail} onChange={(e) => pickMail(e.target.value as MailApp)}>
            <option value="gmail">{MAIL_NAME.gmail}</option>
            <option value="app">{MAIL_NAME.app}</option>
          </select>
          . You press send there.
        </p>
      )}
      {asking && !draft.sent_at && (
        <fieldset className="draft-ai draft-sent-ask">
          <legend className="field-label">
            <Icon name="send" /> Did it go?
          </legend>
          <div className="draft-actions">
            <Button variant="primary" onClick={() => mark('sent', 'Marking it sent.')} disabledReason={busy}>
              Yes, I sent it
            </Button>
            <Button variant="quiet" onClick={() => setAsking(false)}>
              Not yet
            </Button>
          </div>
        </fieldset>
      )}
      {busy && (
        <p className="muted draft-status" role="status">
          {busy}
        </p>
      )}
      {note && (
        <p
          className={note.tone === 'fail' ? 'draft-note-fail' : 'muted draft-status'}
          role={note.tone === 'fail' ? 'alert' : 'status'}
        >
          {note.text}
        </p>
      )}
      {mailLink && !draft.sent_at && (
        <p className="muted draft-status">
          Nothing opened?{' '}
          <a href={mailLink} target="_blank" rel="noopener noreferrer">
            Open the message in {MAIL_NAME[mail]}
          </a>
          .
        </p>
      )}

      {emailQueue || mode === 'view' ? (
        <DraftBody text={draft.body} />
      ) : (
        <div className="draft-fields">
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
        </div>
      )}

      {!emailQueue && !locked && (
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

      {!emailQueue && draft.status !== 'rejected' && (
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
    </div>
  );
}

type MailApp = 'gmail' | 'app';
const MAIL_PREF = 'fw:mail-app';
const MAIL_NAME: Record<MailApp, string> = { gmail: 'Gmail', app: 'your mail app' };

function readMailApp(): MailApp {
  try {
    return localStorage.getItem(MAIL_PREF) === 'app' ? 'app' : 'gmail';
  } catch {
    return 'gmail';
  }
}

/** The address an email draft goes to, or null for a DM, a form, a template or anything not an address. */
export function mailAddress(d: FlowDraft): string | null {
  const to = (d.to ?? '').trim();
  return /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[a-z]{2,}$/i.test(to) ? to : null;
}

/** A link that starts a new message, filled in, in the Owner's own mail. Opening it sends nothing. */
export function composeUrl(app: MailApp, to: string, subject: string, body: string): string {
  const q = (v: string) => encodeURIComponent(v);
  return app === 'gmail'
    ? `https://mail.google.com/mail/?view=cm&fs=1&to=${q(to)}&su=${q(subject)}&body=${q(body)}`
    : `mailto:${q(to)}?subject=${q(subject)}&body=${q(body)}`;
}

/** FW-C-089: the draft as it will paste, with the Frequency logo above the sign-off. */
function DraftBody({ text }: { text: string }) {
  const s = splitSignOff(text);
  if (!s) return <div className="draft-body">{text}</div>;
  return (
    <div className="draft-body">
      {s.before ? `${s.before}\n\n` : ''}
      <img className="draft-logo" src={LOGO_URL} alt="Frequency" width={32} height={32} />
      {s.signOff}
      {s.after ? `\n\n${s.after}` : ''}
    </div>
  );
}
