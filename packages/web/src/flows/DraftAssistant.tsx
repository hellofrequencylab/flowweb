// FW-C-076: an AI assistant on each draft. A back-and-forth: the Owner says how, the AI's version goes into
// the editor unsaved, and the next ask rewrites that version. Every version stays in the conversation so any
// one can be put back. It uses the existing rewrite route (FW-C-051), which answers a proposal and never
// changes the draft. Nothing is saved until Save and nothing is sent.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { FlowDraft } from '../api/types';
import { Button } from '../ui-kit/Button';
import { Icon } from '../ui-kit/Icon';

const QUICK = ['Shorter', 'Warmer and more personal', 'More specific about their event', 'Fix grammar only'];

export type DraftText = { subject: string; body: string };

type Turn =
  | { ask: string; at: string; version: DraftText; before: DraftText }
  | { ask: string; at: string; error: string };

const keyOf = (flow: string, id: string) => `fw.draft-assistant.${flow}.${id}`;

function load(flow: string, id: string): Turn[] {
  try {
    const raw = sessionStorage.getItem(keyOf(flow, id));
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? (v as Turn[]) : [];
  } catch {
    return [];
  }
}

function keep(flow: string, id: string, turns: Turn[]) {
  try {
    sessionStorage.setItem(keyOf(flow, id), JSON.stringify(turns.slice(-30)));
  } catch {
    /* private window or storage off: the conversation lasts as long as the page */
  }
}

export function DraftAssistant({
  flow,
  draft,
  current,
  blocked,
  onText,
}: {
  flow: string;
  draft: FlowDraft;
  /** What the next ask rewrites: the editor's text while editing, else the saved draft. */
  current: DraftText;
  /** Why the assistant cannot act right now (another change is running), or null. */
  blocked: string | null;
  /** Put a version into the editor, unsaved. */
  onText: (t: DraftText) => void;
}) {
  const [turns, setTurns] = useState<Turn[]>(() => load(flow, draft.id));
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const logRef = useRef<HTMLOListElement>(null);

  useEffect(() => keep(flow, draft.id, turns), [flow, draft.id, turns]);
  useEffect(() => {
    const el = logRef.current;
    if (el && turns.length) el.scrollTop = el.scrollHeight;
  }, [turns.length]);

  const original: DraftText = { subject: draft.subject ?? '', body: draft.body };
  const versions = turns.filter((t): t is Extract<Turn, { version: DraftText }> => 'version' in t);
  const same = (a: DraftText, b: DraftText) => a.subject === b.subject && a.body === b.body;
  // Undo walks back one step from what is in the editor: to the text the shown version was made from.
  // If the Owner changed the text by hand, it goes back to before the latest rewrite.
  const undo = () => {
    const shown = [...versions].reverse().find((v) => same(v.version, current));
    const to = shown ?? versions[versions.length - 1];
    if (to) onText(to.before);
  };
  const why = blocked ?? busy;

  async function ask(how: string) {
    const before = current;
    setBusy('Rewriting with AI.');
    setInstruction('');
    const at = new Date().toISOString();
    try {
      const r = await api.draftChange<{ subject: string | null; body: string }>(
        flow,
        draft.id,
        'rewrite',
        { instruction: how, subject: before.subject, body: before.body },
        () => setBusy('Rewriting with AI. Waiting for your Mac to answer.'),
      );
      const version = { subject: r.subject ?? before.subject, body: r.body };
      setTurns((t) => [...t, { ask: how, at, version, before }]);
      onText(version);
    } catch (e) {
      setTurns((t) => [...t, { ask: how, at, error: (e as Error).message }]);
    } finally {
      setBusy(null);
    }
  }

  const go = () => {
    const how = instruction.trim();
    if (how && !why) void ask(how);
  };

  return (
    <div className="draft-ai draft-rewrite draft-assistant">
      <span className="field-label">
        <Icon name="sparkles" size={14} /> AI assistant
      </span>

      {turns.length > 0 && (
        <ol className="assist-log" role="log" aria-label="AI conversation" ref={logRef}>
          {turns.map((t) => (
            <li key={t.at} className="assist-turn">
              <p className="assist-ask">
                <span className="assist-who">You</span> {t.ask}
              </p>
              {'error' in t ? (
                <p className="assist-reply assist-failed" role="alert">
                  <span className="assist-who">AI</span> {t.error}
                </p>
              ) : (
                <div className="assist-reply">
                  <span className="assist-who">AI</span>
                  {t.version.subject && <p className="assist-subject">{t.version.subject}</p>}
                  <pre className="assist-body">{t.version.body}</pre>
                  <Button
                    className="btn-small"
                    variant="quiet"
                    onClick={() => onText(t.version)}
                    disabledReason={why}
                  >
                    Use this version
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      <div className="draft-actions">
        {QUICK.map((q) => (
          <Button key={q} className="btn-small" onClick={() => void ask(q)} disabledReason={why}>
            {q}
          </Button>
        ))}
      </div>
      <div className="draft-ai-ask">
        <input
          type="text"
          aria-label="Tell AI how to rewrite this draft"
          placeholder={
            versions.length
              ? 'Keep going, e.g. now mention the date'
              : 'Say how, e.g. mention our Carlsbad Circles'
          }
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          maxLength={2000}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go();
          }}
        />
        <Button
          onClick={go}
          disabledReason={why ?? (instruction.trim() ? null : 'Say how to rewrite it first.')}
        >
          Rewrite
        </Button>
      </div>

      {versions.length > 0 && (
        <div className="draft-actions">
          <Button className="btn-small" variant="quiet" onClick={undo} disabledReason={why}>
            Undo last rewrite
          </Button>
          <Button className="btn-small" variant="quiet" onClick={() => onText(original)} disabledReason={why}>
            Back to the original
          </Button>
          <Button
            className="btn-small"
            variant="quiet"
            onClick={() => setTurns([])}
            disabledReason={why}
            title="Clears the conversation. The editor keeps its text."
          >
            Clear conversation
          </Button>
        </div>
      )}

      {busy && (
        <p className="muted" role="status">
          {busy}
        </p>
      )}
      <p className="muted draft-ai-hint">
        AI runs on your Mac with your plan. Each version lands in the editor; nothing is saved until you press
        Save, and nothing is sent.
      </p>
    </div>
  );
}
