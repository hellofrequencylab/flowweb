// FW-C-109: the Owner pastes event listings (or a forwarded email), or gives one city or library calendar
// address, and checks each event fwd pulled out. Approving marks it ready for the Owner to act on by hand;
// nothing here publishes, posts or sends.
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { eventIntake, type IntakeEvent } from '../api/client';
import { Button } from '../ui-kit/Button';

type Said = { tone: 'ok' | 'warn'; text: string } | null;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const QUEUED: Said = { tone: 'ok', text: 'Sent to your Mac. Waiting for it to answer.' };

function Outcome({ said }: { said: Said }) {
  if (!said) return null;
  return (
    <div className={`callout callout-${said.tone}`} role={said.tone === 'warn' ? 'alert' : 'status'}>
      {said.text}
    </div>
  );
}

const whenOf = (e: IntakeEvent) => (e.starts_at ? e.starts_at.replace('T', ' at ') : 'no date found');

export function EventIntake({ flow }: { flow: string }) {
  const id = useId();
  const [events, setEvents] = useState<IntakeEvent[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said>(null);
  const load = useCallback(async () => {
    try {
      setEvents(await eventIntake.list(flow));
    } catch (e) {
      setSaid({ tone: 'warn', text: `Could not load the events: ${message(e)}` });
    }
  }, [flow]);
  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const v = text.trim();
    setBusy(true);
    setSaid(null);
    try {
      const input = /^https?:\/\/\S+$/i.test(v) ? { ical_url: v } : { text: v };
      const r = await eventIntake.add(flow, input, () => setSaid(QUEUED));
      const dup = r.duplicates ? `, ${r.duplicates} already queued` : '';
      setSaid({
        tone: 'ok',
        text: `Found ${r.added.length} new event${r.added.length === 1 ? '' : 's'}${dup}.`,
      });
      setText('');
      await load();
    } catch (err) {
      setSaid({ tone: 'warn', text: message(err) });
    } finally {
      setBusy(false);
    }
  };
  const check = async (ev: IntakeEvent, ok: boolean) => {
    setSaid(null);
    try {
      const r = await eventIntake.check(flow, ev.id, ok, () => setSaid(QUEUED));
      const lead = r.lead_added ? ` ${ev.host_name} joined your leads.` : '';
      setSaid({ tone: 'ok', text: `${ok ? 'Approved' : 'Rejected'} ${ev.title}.${lead}` });
    } catch (err) {
      setSaid({ tone: 'warn', text: message(err) });
    }
    await load();
  };

  const waiting = (events ?? []).filter((e) => e.status === 'needs_check');
  return (
    <section className="panel stack" aria-labelledby={id}>
      <h2 id={id}>Paste events</h2>
      <p className="muted">
        Paste listings or a forwarded email, one event per line, or a city or library calendar address. Each
        event waits here for your check. Nothing is published or sent.
      </p>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span className="field-label">Listings or calendar address</span>
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <div className="row">
          <Button
            type="submit"
            disabledReason={busy ? 'Reading.' : text.trim() ? null : 'Paste something first.'}
          >
            Read events
          </Button>
        </div>
      </form>
      <Outcome said={said} />
      {events !== null && waiting.length === 0 && <p className="muted">No events waiting for a check.</p>}
      {waiting.length > 0 && (
        <ul className="plain-list stack" aria-label="Events to check">
          {waiting.map((e) => (
            <li key={e.id}>
              <div>
                <strong>{e.title}</strong>
                <span className="muted">
                  {` · ${whenOf(e)}`}
                  {e.venue ? ` · ${e.venue}` : ''}
                  {e.town ? ` · ${e.town}` : ''}
                  {e.host_name ? ` · hosted by ${e.host_name}` : ''}
                  {e.niche ? ` · ${e.niche}` : ''}
                </span>
                {/^https?:\/\//i.test(e.source_url ?? '') && (
                  <a href={e.source_url ?? undefined} target="_blank" rel="noreferrer noopener">
                    {' '}
                    source
                  </a>
                )}
              </div>
              <div className="row">
                <Button
                  className="btn-small"
                  onClick={() => void check(e, true)}
                  aria-label={`Approve ${e.title}`}
                >
                  Looks right
                </Button>
                <Button
                  className="btn-small"
                  variant="quiet"
                  onClick={() => void check(e, false)}
                  aria-label={`Reject ${e.title}`}
                >
                  Reject
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
