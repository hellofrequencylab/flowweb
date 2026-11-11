// FW-C-108: the reply helper. The Owner pastes a host's reply and gets a drafted answer from the flow's
// reply tree, saved in the drafts inbox for them to check and send by hand. A "no" drafts nothing and
// puts the sender on do-not-contact. Nothing here sends anything.
import { type FormEvent, useId, useState } from 'react';
import { ownerWrite } from '../api/client';
import { Button } from '../ui-kit/Button';

interface ReplyAnswer {
  intent: string;
  niche: string;
  do_not_contact: boolean;
  draft: { id: string; body: string; status: string } | null;
  gate: { ok: boolean; blocks: { code: string; detail: string }[] } | null;
}

const NICHES = ['', 'teacher', 'studio', 'gathering', 'maker', 'music', 'venue'];
const INTENT: Record<string, string> = {
  interested: 'Interested',
  asks_price: 'Asks about price',
  asks_what: 'Asks what it is',
  asks_time: 'Asks how long it takes',
  other_tool: 'Uses another tool',
  not_now: 'Not now',
  no: 'Said no',
  unclear: 'Unclear',
};

export function ReplyHelper({ flow }: { flow: string }) {
  const id = useId();
  const [text, setText] = useState('');
  const [contact, setContact] = useState('');
  const [niche, setNiche] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<ReplyAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (text.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        text,
        ...(contact.trim() ? { contact: contact.trim() } : {}),
        ...(niche ? { niche } : {}),
      };
      setAnswer(await ownerWrite<ReplyAnswer>('POST', `/v1/flows/${encodeURIComponent(flow)}/replies`, body));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel stack" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>Answer a reply</h2>
      <p className="muted">
        Paste what a host wrote back. You get a short answer to check, saved in your drafts. A no puts them on
        do-not-contact.
      </p>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <label htmlFor={`${id}-text`}>Their reply</label>
        <textarea id={`${id}-text`} rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="row">
          <label htmlFor={`${id}-contact`}>Their email or profile (optional)</label>
          <input id={`${id}-contact`} value={contact} onChange={(e) => setContact(e.target.value)} />
          <label htmlFor={`${id}-niche`}>Niche</label>
          <select id={`${id}-niche`} value={niche} onChange={(e) => setNiche(e.target.value)}>
            {NICHES.map((n) => (
              <option key={n} value={n}>
                {n === '' ? 'Guess from the reply' : n}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" disabled={busy || text.trim() === ''}>
          {busy ? 'Drafting' : 'Draft an answer'}
        </Button>
      </form>
      {error && (
        <div className="callout callout-warn" role="alert">
          {error}
        </div>
      )}
      {answer && (
        <div className="callout callout-ok stack" role="status">
          <strong>{INTENT[answer.intent] ?? answer.intent}</strong>
          {answer.draft === null ? (
            <span>
              {answer.do_not_contact
                ? 'No draft. They are on do-not-contact and their sequence has ended.'
                : 'No draft, and nobody was added to do-not-contact: give their email or profile.'}
            </span>
          ) : (
            <>
              <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{answer.draft.body}</p>
              <span className="muted">
                {answer.gate?.ok === false
                  ? `Held by the draft check: ${answer.gate.blocks.map((b) => b.detail).join('; ')}.`
                  : 'Saved in your drafts, waiting for you. Send it by hand.'}
              </span>
            </>
          )}
        </div>
      )}
    </section>
  );
}
