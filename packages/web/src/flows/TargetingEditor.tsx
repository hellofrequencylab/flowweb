// FW-C-156: who a flow looks for and how its notes read, edited in place. Each box is one line of the
// flow's hunt playbook; a save changes this flow only and the next run uses it. On flowweb.app the save is
// queued and applied on the Owner's Mac by the relay.
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { flowTargeting, type Targeting, type TargetingEdit } from '../api/client';
import { Button } from '../ui-kit/Button';

type Said = { tone: 'ok' | 'warn'; text: string } | null;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The playbook lines in the order the hunt reads them, in the Owner's words. */
export const TARGETING_FIELDS: { key: string; label: string; hint: string }[] = [
  { key: 'seek', label: 'Who to look for', hint: 'The kind of person or place this flow is for.' },
  { key: 'signals', label: 'Signs of a good fit', hint: 'What tells you they are worth writing to.' },
  { key: 'where', label: 'Where to look', hint: 'Sites, directories and calendars to search.' },
  { key: 'queries', label: 'Searches to try', hint: 'Phrases to search for.' },
  { key: 'skip', label: 'Who to skip', hint: 'People and places this flow should leave alone.' },
  { key: 'rank', label: 'Who comes first', hint: 'How to pick the best few when there are many.' },
  { key: 'record', label: 'What to note about each', hint: 'The details the note will draw on.' },
  { key: 'note', label: 'How the note reads', hint: 'Voice, length and what the opening line should do.' },
];

type Form = { playbook: Record<string, string>; link_line: string; angles: Record<string, string> };
const formOf = (t: Targeting): Form => ({
  playbook: { ...t.playbook },
  link_line: t.link_line,
  angles: Object.fromEntries(t.niches.map((n) => [n.key, n.angles.map((a) => a.line).join('\n')])),
});

/** Only what the Owner changed, so a save never rewrites a line they did not touch. */
export function editOf(t: Targeting, f: Form): TargetingEdit {
  const edit: TargetingEdit = {};
  const playbook = Object.fromEntries(
    Object.entries(f.playbook).filter(([k, v]) => v.trim() !== (t.playbook[k] ?? '')),
  );
  if (Object.keys(playbook).length) edit.playbook = playbook;
  if (f.link_line.trim() !== t.link_line) edit.link_line = f.link_line.trim();
  for (const n of t.niches) {
    const lines = (f.angles[n.key] ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.join('\n') === n.angles.map((a) => a.line).join('\n')) continue;
    // A line the Owner kept keeps its key, so what the flow has learned about it still counts.
    const angles = lines.map((line) => {
      const kept = n.angles.find((a) => a.line === line);
      return kept ? { key: kept.key, line } : { line };
    });
    edit.niches = { ...edit.niches, [n.key]: { angles } };
  }
  return edit;
}

export function TargetingEditor({ flow }: { flow: string }) {
  const id = useId();
  const [t, setT] = useState<Targeting | null>(null);
  const [f, setF] = useState<Form | null>(null);
  const [said, setSaid] = useState<Said>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const got = await flowTargeting.get(flow);
      setT(got);
      setF(formOf(got));
    } catch (e) {
      setSaid({ tone: 'warn', text: `Could not load these settings: ${message(e)}` });
    }
  }, [flow]);
  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!t || !f) return;
    const edit = editOf(t, f);
    if (Object.keys(edit).length === 0) {
      setSaid({ tone: 'ok', text: 'Nothing to save.' });
      return;
    }
    setBusy(true);
    setSaid(null);
    let queued = false;
    try {
      const saved = await flowTargeting.save(flow, edit, () => {
        queued = true;
        setSaid({ tone: 'ok', text: 'Sent to your Mac. Waiting for it to answer.' });
      });
      if (saved?.playbook) {
        setT(saved);
        setF(formOf(saved));
      } else if (queued) window.setTimeout(() => void load(), 8000);
      setSaid({ tone: 'ok', text: 'Saved. The next run uses it.' });
    } catch (err) {
      setSaid({ tone: 'warn', text: message(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel stack" aria-labelledby={id}>
      <h2 id={id}>Who it looks for and how it writes</h2>
      <p className="muted">
        This is what the flow reads before each hunt. Change a box and save, and the next run follows it.
        Notes already written stay as they are.
      </p>
      {!f && !said && <p className="muted">Loading these settings.</p>}
      {t && !t.has_playbook && (
        <p className="muted">
          This flow follows its built-in brief until the first two boxes, who to look for and how the note
          reads, are filled.
        </p>
      )}
      {t && f && (
        <form className="stack" onSubmit={submit}>
          {TARGETING_FIELDS.map((x) => (
            <label className="field" key={x.key}>
              <span className="field-label">{x.label}</span>
              <textarea
                rows={x.key === 'note' || x.key === 'seek' ? 5 : 3}
                maxLength={1200}
                value={f.playbook[x.key] ?? ''}
                onChange={(e) => setF({ ...f, playbook: { ...f.playbook, [x.key]: e.target.value } })}
              />
              <span className="muted small">{x.hint}</span>
            </label>
          ))}
          <label className="field">
            <span className="field-label">The line before the link</span>
            <input
              type="text"
              maxLength={200}
              value={f.link_line}
              onChange={(e) => setF({ ...f, link_line: e.target.value })}
            />
            <span className="muted small">
              {t.door
                ? `The link opens ${t.door} on Frequency.`
                : 'The link opens the host page on Frequency.'}
            </span>
          </label>
          {t.niches.map((n) => (
            <label className="field" key={n.key}>
              <span className="field-label">Reasons to care: {n.label}</span>
              <textarea
                rows={Math.max(3, n.angles.length + 1)}
                value={f.angles[n.key] ?? ''}
                onChange={(e) => setF({ ...f, angles: { ...f.angles, [n.key]: e.target.value } })}
              />
              <span className="muted small">One per line. The note picks the one that fits the person.</span>
            </label>
          ))}
          <div className="row">
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving' : 'Save'}
            </Button>
          </div>
        </form>
      )}
      {said &&
        (said.tone === 'warn' ? (
          <div className="callout callout-warn" role="alert" style={{ overflowWrap: 'anywhere' }}>
            <p>{said.text}</p>
          </div>
        ) : (
          <div className="callout callout-ok" role="status">
            {said.text}
          </div>
        ))}
    </section>
  );
}
