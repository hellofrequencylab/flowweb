// FW-C-165: the profiles the main flow ships that are not flows yet, each with one button that makes it.
// A flow made here starts off, on Draft: nothing runs until the Owner turns it on from its own card. On
// flowweb.app the request is queued and the Owner's Mac makes the flow.
import { useCallback, useEffect, useState } from 'react';
import { type FlowProfile, flowProfiles } from '../api/client';
import { Link } from '../shell/router';
import { Button } from '../ui-kit/Button';
import { SectionHead } from '../ui-kit/page';

const BASE = 'neighborhood-activation';
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
type Row = { busy?: boolean; waiting?: boolean; key?: string; error?: string };

/** Shows nothing while the list is unknown or every profile is made, so the page never claims a guess. */
export function MoreProfiles({ flow = BASE }: { flow?: string }) {
  const [list, setList] = useState<FlowProfile[] | null>(null);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const load = useCallback(async () => {
    try {
      const got = await flowProfiles.list(flow);
      setList(Array.isArray(got) ? got : []);
    } catch {
      // An older fwd, or a mirror that has not caught up, has no list yet.
    }
  }, [flow]);
  useEffect(() => {
    void load();
  }, [load]);

  const switchOn = async (slug: string) => {
    const set = (r: Row) => setRows((all) => ({ ...all, [slug]: r }));
    set({ busy: true });
    try {
      const made = await flowProfiles.switchOn(flow, slug, () => set({ busy: true, waiting: true }));
      set({ key: made?.key ?? `${flow}--${slug}` });
    } catch (e) {
      set({ error: message(e) });
    }
  };

  // A profile switched on in this visit stays listed with its link, even after the list reloads.
  const shown = (list ?? []).filter((p) => !p.copy_key || rows[p.slug]?.key);
  if (shown.length === 0) return null;
  return (
    <section className="flows-home-section" aria-labelledby="more-profiles">
      <SectionHead
        id="more-profiles"
        title="More profiles, built and ready"
        meta="Each starts off, on Draft"
      />
      <ul
        className="stack"
        aria-label="Profiles not switched on yet"
        style={{ listStyle: 'none', padding: 0 }}
      >
        {shown.map((p) => {
          const r = rows[p.slug] ?? {};
          return (
            <li key={p.slug} className="panel stack">
              <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
                <strong>{p.name}</strong>
                {!r.key && (
                  <Button
                    onClick={() => void switchOn(p.slug)}
                    disabled={r.busy}
                    aria-label={`Switch on ${p.name}`}
                  >
                    {r.busy ? 'Switching on' : 'Switch on'}
                  </Button>
                )}
              </div>
              {p.note && <p className="muted">{p.note}</p>}
              {r.waiting && !r.key && !r.error && (
                <div className="callout callout-ok" role="status">
                  Sent to your Mac. Waiting for it to answer.
                </div>
              )}
              {r.key && (
                <div className="callout callout-ok" role="status">
                  Made. It is off, on Draft, and nothing runs until you turn it on.{' '}
                  <Link to={`/flows/${encodeURIComponent(r.key)}`}>Open {p.name}</Link>
                </div>
              )}
              {r.error && (
                <div className="callout callout-warn" role="alert" style={{ overflowWrap: 'anywhere' }}>
                  <p>{r.error}</p>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
