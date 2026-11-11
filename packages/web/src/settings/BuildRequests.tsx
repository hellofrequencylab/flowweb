// FW-C-112: build requests, in Settings on the live site. Something FlowWeb cannot do yet, written up (usually
// by Kevin, the AI console) for the builder, which turns it into a pull request. Owners and admins can also
// write one here; everyone in the business sees the list and how far each one has got.
import { useState } from 'react';
import { ApiError, api, type BuildRequest } from '../api/client';
import { useResource } from '../api/resource';
import { Button } from '../ui-kit/Button';
import { ResourceView } from '../ui-kit/honest';
import { when } from '../ui-kit/time';

const STATUS: Record<BuildRequest['status'], { text: string; tone: string }> = {
  new: { text: 'Waiting for the builder', tone: 'status-neutral' },
  building: { text: 'Being built', tone: 'status-warn' },
  pr_open: { text: 'Built, checks running', tone: 'status-warn' },
  done: { text: 'Shipped', tone: 'status-ok' },
  declined: { text: 'Not built', tone: 'status-neutral' },
};

function Item({ r }: { r: BuildRequest }) {
  const s = STATUS[r.status] ?? STATUS.new;
  return (
    <li className="stack build-request">
      <div className="row">
        <strong>{r.title}</strong>
        <span className={`status ${s.tone}`}>{s.text}</span>
      </div>
      <p className="small">{r.what}</p>
      {r.done_when && <p className="small muted">Done when: {r.done_when}</p>}
      {r.note && <p className="small muted">{r.note}</p>}
      <p className="small muted">
        Asked {when(r.created_at)}
        {r.pr_url && (
          <>
            {' · '}
            <a href={r.pr_url} target="_blank" rel="noreferrer">
              Pull request
            </a>
          </>
        )}
      </p>
    </li>
  );
}

function AskForm({ reload }: { reload: () => void }) {
  const [title, setTitle] = useState('');
  const [what, setWhat] = useState('');
  const [doneWhen, setDoneWhen] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async () => {
    setBusy(true);
    setNote(null);
    try {
      await api.addBuildRequest({ title: title.trim(), what: what.trim(), done_when: doneWhen.trim() });
      setTitle('');
      setWhat('');
      setDoneWhen('');
      setNote({ ok: true, text: 'Saved. The builder picks it up within the hour.' });
      reload();
    } catch (e) {
      setNote({ ok: false, text: e instanceof ApiError ? e.message : 'That did not save. Try again.' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" aria-label="Ask for something new" onSubmit={(e) => e.preventDefault()}>
      <label className="stack">
        <span className="field-label">What should it be called?</span>
        <input type="text" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="stack">
        <span className="field-label">What do you want, and why?</span>
        <textarea rows={3} maxLength={4000} value={what} onChange={(e) => setWhat(e.target.value)} />
      </label>
      <label className="stack">
        <span className="field-label">How will you know it works?</span>
        <textarea rows={2} maxLength={1000} value={doneWhen} onChange={(e) => setDoneWhen(e.target.value)} />
      </label>
      <Button
        onClick={() => void save()}
        disabledReason={
          busy ? 'Saving…' : !title.trim() || !what.trim() ? 'Give it a name and say what you want.' : null
        }
      >
        Save build request
      </Button>
      {note && (
        <p className={`callout ${note.ok ? 'callout-ok' : 'callout-warn'}`} role="status">
          {note.text}
        </p>
      )}
    </form>
  );
}

/** Settings, "Build requests". Hosted only: the list lives with the business, not on a machine. */
export function BuildRequests() {
  const res = useResource('build-requests', () => api.buildRequests(), []);
  const [asking, setAsking] = useState(false);
  return (
    <section className="settings-group" aria-labelledby="build-h">
      <h2 id="build-h">
        Build requests
        <span className="setting-desc">
          Things FlowWeb cannot do yet. Ask Kevin, or write one here. The builder turns each into a pull
          request, and it ships when the checks pass. Changes to the database still come to the owner first.
        </span>
      </h2>
      <div className="settings-body">
        <div className="panel settings-panel stack">
          <ResourceView res={res} what="build requests">
            {({ requests: list }) =>
              list.length ? (
                <ul className="stack build-requests">
                  {list.map((r) => (
                    <Item key={r.id} r={r} />
                  ))}
                </ul>
              ) : (
                <p className="muted">Nothing asked for yet. Tell Kevin what you wish FlowWeb did.</p>
              )
            }
          </ResourceView>
          <Button variant="quiet" onClick={() => setAsking((v) => !v)} aria-expanded={asking}>
            {asking ? 'Close' : 'Ask for something new'}
          </Button>
          {asking && <AskForm reload={res.reload} />}
        </div>
      </div>
    </section>
  );
}
