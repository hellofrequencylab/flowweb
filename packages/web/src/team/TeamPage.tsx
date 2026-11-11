// FW-C-123: the Owner's agent team, set out like a company: the CEO (the one agent the Owner talks to),
// the exec team, managers by department, the shared staff pool, contractors and the building.
// Every agent but the building has a personality card; the Owner renames one or changes its voice here.
// Personas are for this team view only: anything a customer sees keeps the business's brand voice.
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { useResource } from '../api/resource';
import type { Team, TeamLevel, TeamMember } from '../api/types';
import { ResourceView } from '../ui-kit/honest';
import { PageHead } from '../ui-kit/page';
import './team.css';

const LEVELS: { level: TeamLevel; heading: string }[] = [
  { level: 'ceo', heading: 'CEO' },
  { level: 'exec', heading: 'Exec team' },
  { level: 'manager', heading: 'Managers' },
  { level: 'staff', heading: 'Staff' },
  { level: 'contractor', heading: 'Contractors' },
  { level: 'building', heading: 'The building' },
];

const DEPARTMENTS: Record<string, string> = {
  operations: 'Operations',
  marketing: 'Marketing',
  sales: 'Sales',
  customers: 'Customers',
  finance: 'Finance',
  build: 'Build',
};

const TIERS: Record<TeamMember['tier'], string> = {
  top: 'Top model, a few times a day',
  mid: 'Mid model, once per cycle',
  small: 'Small model, one item at a time',
  theirs: 'Their own tools, per job',
  none: 'Code, no model',
};

export function TeamPage() {
  const res = useResource('team', () => api.team(), []);
  const [teamKey, setTeamKey] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  return (
    <>
      <PageHead
        title="Your team"
        lede="The crew. You talk to the CEO; everyone else reports up, takes their job very seriously, and has it handled. Go play. They will call you if it matters."
      />
      <ResourceView res={res} what="your team">
        {(d) => {
          const team = d.teams.find((t) => t.key === teamKey) ?? d.teams[0];
          if (!team) return <p className="lede">No crew yet. They are, presumably, on their way.</p>;
          const who = team.members.find((m) => m.id === picked) ?? null;
          return (
            <>
              {d.teams.length > 1 && (
                <div className="segmented team-tabs" role="tablist" aria-label="Teams">
                  {d.teams.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      role="tab"
                      aria-selected={t.key === team.key}
                      onClick={() => {
                        setTeamKey(t.key);
                        setPicked(null);
                      }}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              )}
              <div className="team-layout">
                <OrgChart team={team} picked={picked} onPick={setPicked} />
                {who ? (
                  <Profile key={`${team.key}:${who.id}`} team={team} who={who} onSaved={res.reload} />
                ) : (
                  <p className="team-hint">
                    Pick anyone to meet them: what they care about, the number they answer to, and when they
                    will bother you.
                  </p>
                )}
              </div>
            </>
          );
        }}
      </ResourceView>
    </>
  );
}

function OrgChart({
  team,
  picked,
  onPick,
}: {
  team: Team;
  picked: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <div className="org-chart">
      {LEVELS.map(({ level, heading }) => {
        const ms = team.members.filter((m) => m.level === level);
        if (!ms.length) return null;
        const groups =
          level === 'manager'
            ? Object.keys(DEPARTMENTS)
                .map((d) => [DEPARTMENTS[d] as string, ms.filter((m) => m.department === d)] as const)
                .filter(([, g]) => g.length)
            : ([[null, ms]] as const);
        return (
          <section key={level} className={`org-level org-${level}`} aria-labelledby={`org-${level}`}>
            <h2 id={`org-${level}`}>{heading}</h2>
            {groups.map(([label, g]) => (
              <div key={label ?? level} className="org-group">
                {label && <h3 className="overline">{label}</h3>}
                <ul className="org-people">
                  {g.map((m) => (
                    <li key={m.id}>
                      {level === 'building' ? (
                        <span className="org-card org-card-building">
                          <span className="org-name">{m.name}</span>
                          <span className="org-title">{m.title.replace(/^The building: /, '')}</span>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className={`org-card ${m.status === 'bench' ? 'is-bench' : ''}`}
                          aria-pressed={picked === m.id}
                          onClick={() => onPick(m.id)}
                        >
                          <span className="org-name">{m.name}</span>
                          <span className="org-title">{m.title}</span>
                          <span className="org-status">
                            {m.status === 'bench' ? 'Not hired yet' : 'Working'}
                          </span>
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

function Profile({ team, who, onSaved }: { team: Team; who: TeamMember; onSaved: () => void }) {
  const boss = team.members.find((m) => m.id === who.reports_to);
  const ref = useRef<HTMLElement>(null);
  // On a phone the card sits above the chart: bring it into view when someone is picked.
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, []);
  const [edit, setEdit] = useState<'name' | 'voice' | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async (change: { name?: string | null; voice?: string | null }) => {
    if (busy) return;
    setBusy('Saving.');
    setNote(null);
    try {
      await api.setTeamMember(team.key, who.id, change, () =>
        setBusy('Saving. Waiting for your machine to apply it.'),
      );
      setNote({ ok: true, text: 'Saved.' });
      setEdit(null);
      onSaved();
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!edit || !v) return;
    void save({ [edit]: v });
  };
  const open = (f: 'name' | 'voice') => {
    setEdit(f);
    setValue((f === 'name' ? who.name : who.voice) ?? '');
    setNote(null);
  };

  return (
    <section ref={ref} className="panel team-profile" aria-label={who.name}>
      <header className="team-profile-head">
        <span className="org-face" aria-hidden="true">
          {who.name.replace(/^The /, '').slice(0, 1)}
        </span>
        <div>
          <h2>{who.name}</h2>
          <p className="org-title">{who.title}</p>
        </div>
      </header>
      {who.says && <blockquote className="team-says">{who.says}</blockquote>}
      <dl className="team-card">
        <dt>Archetype</dt>
        <dd>{who.archetype}</dd>
        <dt>Voice</dt>
        <dd>{who.voice}</dd>
        <dt>Cares about</dt>
        <dd>{who.cares_about}</dd>
        <dt>Judged on</dt>
        <dd>{who.judged_on}</dd>
        <dt>Never</dt>
        <dd>{who.never}</dd>
        <dt>Comes to you when</dt>
        <dd>{who.escalates}</dd>
        <dt>Runs on</dt>
        <dd>{TIERS[who.tier]}</dd>
      </dl>
      <p className="team-reports">Reports to {boss ? <strong>{boss.name}</strong> : <strong>you</strong>}</p>
      <p className="team-status">
        {who.status === 'bench'
          ? 'Not hired yet. Starts the day its department has a flow turned on, and is ready.'
          : 'On the job.'}
      </p>
      {edit ? (
        <form className="stack team-edit" onSubmit={submit}>
          <label className="field">
            <span className="field-label">{edit === 'name' ? 'Name' : 'Voice'}</span>
            <input
              className="home-input"
              type="text"
              value={value}
              maxLength={edit === 'name' ? 40 : 200}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
          <div className="row-actions">
            <button type="submit" className="btn btn-small" disabled={Boolean(busy) || !value.trim()}>
              Save
            </button>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setEdit(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="row-actions">
          <button type="button" className="btn btn-small" onClick={() => open('name')}>
            Rename
          </button>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => open('voice')}>
            Change voice
          </button>
          {who.name !== who.default_name && (
            <button
              type="button"
              className="btn btn-small btn-ghost"
              onClick={() => void save({ name: null })}
            >
              Back to {who.default_name}
            </button>
          )}
        </div>
      )}
      {busy && (
        <p className="setting-desc" role="status">
          {busy}
        </p>
      )}
      {note && (
        <p className={`setting-desc ${note.ok ? '' : 'callout-warn'}`} role="status">
          {note.text}
        </p>
      )}
      <p className="team-fine">
        Only you see this personality. Anything a customer reads uses your brand voice, and no agent can skip
        your approval.
      </p>
    </section>
  );
}
