// FW-C-167: "How I write", the Owner's own note about his voice.
//
// One note for every flow. fwd adds it to each hunt brief and each AI rewrite, after the voice that shipped,
// so new drafts follow it. Saving never sends anything. On the live site the save is queued and the relay
// applies it on the machine; on the Mac fwd saves it at once. "Back to the original" clears the saved note,
// which puts the shipped voice back.
import { useEffect, useState } from 'react';
import { ownerVoice } from '../api/client';
import { useResource } from '../api/resource';
import { Button } from '../ui-kit/Button';
import { ResourceView } from '../ui-kit/honest';

const MAX = 2000;

/** Why a note cannot be saved, or null. fwd checks the same things. */
export function noteProblem(note: string): string | null {
  if (note.length > MAX) return `Keep it to ${MAX} characters.`;
  if (/[–—]/.test(note)) return 'Take out the long dash. Use a comma or a new sentence.';
  if (/midnight/i.test(note)) return 'The note may not use the word "Midnight".';
  return null;
}

export function VoiceSettings({ canChange = true }: { canChange?: boolean }) {
  const res = useResource('voice', () => ownerVoice.get());
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const loaded = res.data?.note;
  // The box starts from what is saved (or the original), and follows it again after a save.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the saved note changes
  useEffect(() => setText(null), [loaded]);

  const save = async (note: string, done: string) => {
    if (busy) return;
    setBusy('Saving.');
    setSaid(null);
    let queued = false;
    try {
      await ownerVoice.save(note, () => {
        queued = true;
        setBusy('Saving. Waiting for your machine to apply it.');
      });
      setSaid({ ok: true, text: done });
    } catch (e) {
      setSaid({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
      res.reload();
      if (queued) window.setTimeout(res.reload, 8000);
    }
  };

  const locked = canChange ? null : 'Only an owner or admin can change this.';
  return (
    <section className="settings-group" aria-labelledby="voice-h">
      <h2 id="voice-h">
        How I write
        <span className="setting-desc">Your own note about your voice, for every flow.</span>
      </h2>
      <div className="settings-body">
        <div className="panel settings-panel">
          <ResourceView res={res} what="your note">
            {(d) => {
              const note = text ?? d.note;
              const problem = noteProblem(note);
              const empty = note.trim() === '' ? 'Write a note first, or go back to the original.' : null;
              const same = d.saved && note.trim() === d.note.trim();
              return (
                <form className="stack" aria-label="How I write" onSubmit={(e) => e.preventDefault()}>
                  <label className="stack">
                    <span className="field-label">How I write</span>
                    <span className="small muted">
                      Every new draft and every AI rewrite follows this note. Saving it never sends anything.
                    </span>
                    <textarea
                      rows={10}
                      maxLength={MAX}
                      value={note}
                      readOnly={Boolean(locked)}
                      onChange={(e) => setText(e.target.value)}
                    />
                  </label>
                  <span className="setting-desc">
                    {d.saved
                      ? 'This is your saved note.'
                      : 'This is the original that shipped. Change it and save to make it yours.'}
                    {d.edits > 0
                      ? ` ${d.edits} of your ${d.edits === 1 ? 'edit' : 'edits'} kept to learn from.`
                      : ''}
                  </span>
                  <div className="row">
                    <Button
                      onClick={() => void save(note.trim(), 'Saved. New drafts and rewrites follow it.')}
                      disabledReason={locked ?? busy ?? problem ?? empty}
                      disabled={same}
                    >
                      Save
                    </Button>
                    <Button
                      variant="quiet"
                      onClick={() => void save('', 'Back to the original.')}
                      disabledReason={locked ?? busy}
                      disabled={!d.saved}
                    >
                      Back to the original
                    </Button>
                  </div>
                  {busy && (
                    <span className="setting-desc" role="status">
                      {busy}
                    </span>
                  )}
                  {said && (
                    <span className={`setting-desc ${said.ok ? '' : 'callout-warn'}`} role="status">
                      {said.text}
                    </span>
                  )}
                </form>
              );
            }}
          </ResourceView>
        </div>
      </div>
    </section>
  );
}
