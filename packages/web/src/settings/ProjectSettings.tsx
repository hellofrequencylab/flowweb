// FW-C-087: each project's brief and labels, from Settings, for everyone who may change them.
//
// Before this the brief (five plain answers every agent reads) and the brand and category were set only on
// the Owner's Mac with `fw project brief` and `fw project label`. On the Mac fwd saves a change at once; on
// the live site it is queued (kinds project.brief and project.labels) and the relay applies it there.
import { useId, useState } from 'react';
import { api } from '../api/client';
import { useResource } from '../api/resource';
import type { Project, ProjectBriefAnswers } from '../api/types';
import { CATEGORIES } from '../projects/ProjectsPage';
import { Button } from '../ui-kit/Button';
import { ResourceView } from '../ui-kit/honest';

/** The five brief questions, in the order `fw setup` asks them. */
export const BRIEF_FIELDS: { key: keyof ProjectBriefAnswers; label: string; hint: string }[] = [
  { key: 'what', label: 'What is it', hint: 'In one or two sentences.' },
  { key: 'who', label: 'Who is it for', hint: 'The people it serves.' },
  { key: 'voice', label: 'How it sounds', hint: 'The voice, in a few words.' },
  { key: 'never', label: 'What agents must never do', hint: 'Hard lines for every run.' },
  { key: 'done', label: 'What done looks like', hint: 'Something you could check.' },
];

const EMPTY: ProjectBriefAnswers = { what: '', who: '', voice: '', never: '', done: '' };
const MAX = 1000;

function ProjectForm({ p, canChange, reload }: { p: Project; canChange: boolean; reload: () => void }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [brief, setBrief] = useState<ProjectBriefAnswers>(p.brief ?? EMPTY);
  const [brand, setBrand] = useState(p.brand ?? '');
  const [category, setCategory] = useState(p.category ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const missing = BRIEF_FIELDS.find((f) => !brief[f.key].trim());
  const save = async (what: 'brief' | 'labels') => {
    setBusy('Saving.');
    setNote(null);
    let queued = false;
    const onQueued = () => {
      queued = true;
      setBusy('Saving. Waiting for your machine to apply it.');
    };
    try {
      if (what === 'brief') await api.setProjectBrief(p.id, brief, onQueued);
      else
        await api.setProjectLabels(
          p.id,
          { brand: brand.trim() || null, category: category || null },
          onQueued,
        );
      setNote({
        ok: true,
        text: what === 'brief' ? 'Brief saved. Agents use it from the next run.' : 'Labels saved.',
      });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
      reload();
      if (queued) window.setTimeout(reload, 8000);
    }
  };

  const locked = canChange ? null : 'Only an owner or admin can change this.';
  return (
    <div className="setting project-setting">
      <span className="setting-text">
        <span className="setting-label">{p.name}</span>
        <span className="setting-desc">
          {p.brief ? 'Has a brief.' : 'No brief yet. Agents write better with one.'}
          {p.brand ? ` ${p.brand}.` : ''}
        </span>
      </span>
      <Button
        className="btn-small"
        variant="quiet"
        aria-expanded={open}
        aria-controls={`${id}-form`}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Close' : canChange ? 'Edit' : 'View'}
      </Button>
      {open && (
        <form
          id={`${id}-form`}
          className="stack project-form"
          aria-label={`Brief and labels for ${p.name}`}
          onSubmit={(e) => e.preventDefault()}
        >
          {BRIEF_FIELDS.map((f) => (
            <label key={f.key} className="stack">
              <span className="field-label">{f.label}</span>
              <span className="small muted">{f.hint}</span>
              <textarea
                rows={2}
                maxLength={MAX}
                value={brief[f.key]}
                readOnly={Boolean(locked)}
                onChange={(e) => setBrief((b) => ({ ...b, [f.key]: e.target.value }))}
              />
            </label>
          ))}
          <Button
            onClick={() => void save('brief')}
            disabledReason={locked ?? busy ?? (missing ? `Answer "${missing.label}" first.` : null)}
          >
            Save brief
          </Button>
          <div className="row">
            <label className="stack">
              <span className="field-label">Brand</span>
              <input
                type="text"
                maxLength={64}
                value={brand}
                readOnly={Boolean(locked)}
                onChange={(e) => setBrand(e.target.value)}
              />
            </label>
            <label className="stack">
              <span className="field-label">Category</span>
              <select
                value={category}
                disabled={Boolean(locked)}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="">None</option>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c[0]?.toUpperCase()}
                    {c.slice(1)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Button variant="quiet" onClick={() => void save('labels')} disabledReason={locked ?? busy}>
            Save labels
          </Button>
          {busy && (
            <p className="small muted" role="status">
              {busy}
            </p>
          )}
          {note && (
            <p className={`callout ${note.ok ? 'callout-ok' : 'callout-warn'}`} role="status">
              {note.text}
            </p>
          )}
        </form>
      )}
    </div>
  );
}

/** Settings, "Projects": each project's brief and labels. canChange is false for helpers and viewers. */
export function ProjectSettings({ canChange = true }: { canChange?: boolean }) {
  const res = useResource('projects', () => api.projects(), ['rows']);
  return (
    <section className="settings-group" aria-labelledby="proj-h">
      <h2 id="proj-h">
        Projects
        <span className="setting-desc">The brief every agent reads, and how each project is labelled.</span>
      </h2>
      <div className="settings-body">
        <div className="panel settings-panel">
          <ResourceView res={res} what="projects">
            {(d) =>
              d.projects.length === 0 ? (
                <p>No projects yet. Get started adds your first one.</p>
              ) : (
                d.projects.map((p) => (
                  <ProjectForm key={p.id} p={p} canChange={canChange} reload={res.reload} />
                ))
              )
            }
          </ResourceView>
        </div>
      </div>
    </section>
  );
}
