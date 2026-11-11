// FW-C-118: the Owner's switch for links to Frequency's funnel pages (/start/host, /for/<niche>, /launch).
//
// Before this it was FW_FUNNELS_LIVE in fwd's environment and funnels_live in each flow's config, both on
// the Mac. Here On or Off wins over both, and Flow default hands the choice back to them. On the live site
// the change is queued and the relay applies it on the machine (kind links.funnels); on the Mac fwd applies
// it at once.
import { useState } from 'react';
import { api } from '../api/client';
import { useResource } from '../api/resource';
import type { FunnelsLive } from '../api/types';
import { ResourceView } from '../ui-kit/honest';

const CHOICES: { v: boolean | null; label: string }[] = [
  { v: true, label: 'On' },
  { v: false, label: 'Off' },
  { v: null, label: 'Flow default' },
];

/** Where the links' answer comes from now, in one line. */
export function sourceLine(f: FunnelsLive): string {
  if (f.source === 'setting')
    return f.live ? 'On, set here. Drafts link to the funnel pages.' : 'Off, set here.';
  if (f.source === 'env') return 'Off, from FW_FUNNELS_LIVE on your Mac.';
  return "Each flow's own setup decides.";
}

export function FunnelsSwitch({ canChange = true }: { canChange?: boolean }) {
  const res = useResource('supervisor', () => api.supervisor(), ['runs', 'cards']);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const pick = async (live: boolean | null, current: boolean | null) => {
    if (!canChange || live === current || busy) return;
    setBusy('Saving.');
    setNote(null);
    let queued = false;
    try {
      await api.setFunnelsLive(live, () => {
        queued = true;
        setBusy('Saving. Waiting for your machine to apply it.');
      });
      setNote({ ok: true, text: 'Saved. New drafts use it.' });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
      res.reload();
      if (queued) window.setTimeout(res.reload, 8000);
    }
  };

  const why = !canChange ? 'Only an owner or admin can change this.' : busy;
  return (
    <section className="settings-group" aria-labelledby="funnels-h">
      <h2 id="funnels-h">
        Frequency links
        <span className="setting-desc">Where drafted links send people on Frequency.</span>
      </h2>
      <div className="settings-body">
        <div className="panel settings-panel">
          <ResourceView res={res} what="links">
            {(d) => {
              const f: FunnelsLive = d.funnels_live ?? {
                live: null,
                source: 'config',
                setting: null,
                env_off: false,
              };
              return (
                <fieldset className="setting setting-choice">
                  <legend className="visually-hidden">Frequency funnel pages live</legend>
                  <span className="setting-text" aria-hidden="true">
                    <span className="setting-label">Frequency funnel pages live</span>
                    <span className="setting-desc">
                      Off: drafts link to /create-a-space until Frequency's /start/host, /for/&lt;niche&gt;
                      and /launch pages are live.
                    </span>
                  </span>
                  <span className="segmented">
                    {CHOICES.map((c) => (
                      <label key={String(c.v)}>
                        <input
                          type="radio"
                          name="funnels-live"
                          checked={f.setting === c.v}
                          disabled={Boolean(why)}
                          onChange={() => void pick(c.v, f.setting)}
                        />
                        {c.label}
                      </label>
                    ))}
                  </span>
                  <span className="setting-desc">{sourceLine(f)}</span>
                  {busy && (
                    <span className="setting-desc" role="status">
                      {busy}
                    </span>
                  )}
                  {note && (
                    <span className={`setting-desc ${note.ok ? '' : 'callout-warn'}`} role="status">
                      {note.text}
                    </span>
                  )}
                </fieldset>
              );
            }}
          </ResourceView>
        </div>
      </div>
    </section>
  );
}
