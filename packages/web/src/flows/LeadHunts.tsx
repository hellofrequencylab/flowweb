// FW-C-049: the Owner's lead hunts on the flow page. Lists the saved hunts with Run and Delete, saves a
// new one (with the pages to search first, one per line), and adds an address or an @domain to
// do-not-contact, for an organizer who replied "no". Every write goes through fwd, which does the checking.
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { type LeadHunt, leadHunts } from '../api/client';
import { HOSTED } from '../hosted/auth';
import { Button } from '../ui-kit/Button';
import { when } from '../ui-kit/time';

type Region = { id: string; name: string };
type Said = { tone: 'ok' | 'warn'; text: string } | null;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Outcome({ said }: { said: Said }) {
  if (!said) return null;
  return said.tone === 'warn' ? (
    <div className="callout callout-warn" role="alert" style={{ overflowWrap: 'anywhere' }}>
      <p>{said.text}</p>
    </div>
  ) : (
    <div className="callout callout-ok" role="status">
      {said.text}
    </div>
  );
}

export function LeadHunts({ regions }: { regions: Region[] }) {
  const id = useId();
  const [hunts, setHunts] = useState<LeadHunt[] | null>(null);
  const [listSaid, setListSaid] = useState<Said>(null);
  const load = useCallback(async () => {
    try {
      setHunts(await leadHunts.list());
    } catch (e) {
      setListSaid({ tone: 'warn', text: `Could not load the hunts: ${message(e)}` });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const regionName = (r: string) => regions.find((x) => x.id === r)?.name ?? r;
  const act = async (fn: () => Promise<string>) => {
    setListSaid(null);
    try {
      setListSaid({ tone: 'ok', text: await fn() });
    } catch (e) {
      setListSaid({ tone: 'warn', text: message(e) });
    }
    await load();
  };
  const runNow = (h: LeadHunt) =>
    act(async () => {
      const r = await leadHunts.run(h.id);
      return `${h.name}: ${r.outcome}${r.reason ? `, ${r.reason}` : ''}.`;
    });
  const remove = (h: LeadHunt) => {
    if (!window.confirm(`Delete the hunt "${h.name}"? Drafts it already made stay.`)) return;
    void act(async () => {
      await leadHunts.remove(h.id);
      return `Deleted ${h.name}.`;
    });
  };

  return (
    <section className="panel stack" aria-labelledby={id}>
      <h2 id={id}>Lead hunts</h2>
      <p className="muted">
        Each hunt looks for local events and their organizers' public addresses, and drafts one message per
        organizer. Pages you list are searched first.
      </p>
      {hunts === null && !listSaid && <p className="muted">Loading the hunts.</p>}
      {hunts?.length === 0 && <p className="muted">No hunts saved yet.</p>}
      {hunts && hunts.length > 0 && (
        <ul className="plain-list stack">
          {hunts.map((h) => (
            <li key={h.id}>
              <div>
                <strong>{h.name}</strong>
                <span className="muted">
                  {` · ${h.looking_for} · ${regionName(h.region)} · every ${h.every_days} day${h.every_days === 1 ? '' : 's'}`}
                  {` · up to ${h.max_sends} per run · ${h.links.length} page${h.links.length === 1 ? '' : 's'}`}
                  {h.build ? ' · builds a claim page' : ''}
                  {` · last run ${h.last_run_at ? when(h.last_run_at) : 'never'}`}
                </span>
              </div>
              {!HOSTED && (
                <div className="row">
                  <Button
                    className="btn-small"
                    onClick={() => void runNow(h)}
                    aria-label={`Run ${h.name} now`}
                  >
                    Run now
                  </Button>
                  <Button
                    className="btn-small"
                    variant="quiet"
                    onClick={() => remove(h)}
                    aria-label={`Delete ${h.name}`}
                  >
                    Delete
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <Outcome said={listSaid} />
      {HOSTED ? (
        // The live site is a read-only mirror: a save here would be refused, so offer the command instead.
        <p className="muted small">
          Add, run or remove a hunt, or block an address, on your Mac with <code>pnpm fw hunt</code>.
        </p>
      ) : (
        <>
          <NewHunt regions={regions} saved={load} />
          <Block />
        </>
      )}
    </section>
  );
}

function NewHunt({ regions, saved }: { regions: Region[]; saved: () => Promise<void> }) {
  const [v, setV] = useState({
    name: '',
    looking_for: '',
    region: regions[0]?.id ?? '',
    links: '',
    every: '1',
    max: '10',
  });
  const [build, setBuild] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said>(null);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) =>
    setV({ ...v, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setSaid(null);
    try {
      const h = await leadHunts.save({
        name: v.name.trim(),
        looking_for: v.looking_for.trim(),
        region: v.region,
        links: v.links
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
        every_days: Number(v.every),
        max_sends: Number(v.max),
        build,
      });
      setSaid({ tone: 'ok', text: `Saved ${h.name}.` });
      setV({ ...v, name: '', looking_for: '', links: '' });
      setBuild(false);
      await saved();
    } catch (err) {
      setSaid({ tone: 'warn', text: message(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={submit}>
      <h3>New hunt</h3>
      <label className="field">
        <span className="field-label">Name</span>
        <input type="text" value={v.name} onChange={set('name')} required />
      </label>
      <label className="field">
        <span className="field-label">Looking for</span>
        <input type="text" value={v.looking_for} onChange={set('looking_for')} required />
      </label>
      <label className="field">
        <span className="field-label">Region</span>
        <select value={v.region} onChange={set('region')}>
          {regions.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Pages to search first</span>
        <textarea rows={3} value={v.links} onChange={set('links')} placeholder="One address per line" />
      </label>
      <div className="row">
        <label className="field">
          <span className="field-label">Every how many days</span>
          <input type="number" min={1} max={30} value={v.every} onChange={set('every')} />
        </label>
        <label className="field">
          <span className="field-label">Most messages per run</span>
          <input type="number" min={1} max={25} value={v.max} onChange={set('max')} />
        </label>
      </div>
      <label className="row">
        <input type="checkbox" checked={build} onChange={(e) => setBuild(e.target.checked)} />
        <span>Build a page they can claim</span>
      </label>
      <div className="row">
        <Button type="submit" disabledReason={busy ? 'Saving.' : null}>
          Save hunt
        </Button>
      </div>
      <Outcome said={said} />
    </form>
  );
}

function Block() {
  const [address, setAddress] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setSaid(null);
    try {
      const r = await leadHunts.block(address.trim(), reason.trim());
      setSaid({
        tone: 'ok',
        text: `${r.blocked} ${r.already ? 'was already' : 'is now'} on the do-not-contact list.`,
      });
      setAddress('');
      setReason('');
    } catch (err) {
      setSaid({ tone: 'warn', text: message(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={submit}>
      <h3>Someone replied "no"</h3>
      <div className="row">
        <label className="field">
          <span className="field-label">Address or @domain</span>
          <input type="text" value={address} onChange={(e) => setAddress(e.target.value)} required />
        </label>
        <label className="field">
          <span className="field-label">Reason</span>
          <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} required />
        </label>
      </div>
      <div className="row">
        <Button type="submit" variant="stop" disabledReason={busy ? 'Saving.' : null}>
          Add to do-not-contact
        </Button>
      </div>
      <Outcome said={said} />
    </form>
  );
}
