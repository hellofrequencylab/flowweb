import { type ReactNode, useId, useState } from 'react';
import * as C from '../api/client';
import { Button } from '../ui-kit/Button';
import { when } from '../ui-kit/time';

const { ApiError, flowAdmin } = C;
type Props = { flow: C.FlowAdminView; refresh: () => void };
type Lead = C.FlowAdminView['leads'][number];
type Failure = { message: string; reasons: string[] };

/** The activation numbers the Owner can change, in the order and words the form shows them. */
const TARGETS: [key: string, label: string][] = [
  ['hosts_floor', 'Fewest active hosts any region needs'],
  ['hosts_per_10k', 'Active hosts per 10,000 people'],
  ['events_per_host_14d', 'Events per host in the next 14 days'],
  ['sub_area_share', 'Share of sub-areas covered (0 to 1)'],
  ['channels_per_sub_area', 'Channels a sub-area needs to count as covered'],
  ['wam_per_host', 'Weekly active members per host'],
  ['hold_weeks', 'Weeks every target must hold before the next region is proposed'],
  ['upkeep_relapse_weeks', 'Weeks below target before an earlier region is worked again'],
];
const ROUTES: Record<C.SendVia, string> = { founder_email: 'Founder email', frequency: 'Frequency message' };

function failureOf(e: unknown): Failure {
  const errors = e instanceof ApiError ? (e.details as { errors?: unknown } | undefined)?.errors : undefined;
  const message = e instanceof Error ? e.message : String(e);
  return { message, reasons: Array.isArray(errors) ? errors.map(String) : [] };
}

/** One write at a time per control. Keeps the failure, or a line saying what happened, until the next try. */
function useAction(refresh: () => void) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<ReactNode>(null);
  const run = async <T,>(fn: () => Promise<T>, said?: (out: T) => ReactNode): Promise<T | undefined> => {
    setBusy(true);
    setFailure(null);
    setDone(null);
    try {
      const out = await fn();
      setDone(said?.(out) ?? null);
      refresh();
      return out;
    } catch (e) {
      setFailure(failureOf(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  const outcome = (
    <>
      {failure && (
        <div className="callout callout-warn" role="alert" style={{ overflowWrap: 'anywhere' }}>
          <p>{failure.message}</p>
          {failure.reasons.length > 0 && (
            <ul>
              {failure.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {done && (
        <div className="callout callout-ok" role="status">
          {done}
        </div>
      )}
    </>
  );
  return { busy, run, outcome };
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="panel stack" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}

/**
 * Upload and admin controls for the neighborhood activation flow: leads and metrics uploads, opening
 * the proposed region, marking sends, do-not-contact, targets, the raw config, the export and the log.
 * `flow` is the GET /v1/flows/neighborhood-activation view; `refresh` reloads it after each write.
 */
export function FlowAdmin({ flow, refresh }: Props) {
  const leadCols = 'name,kind,territory_id,sub_area,channel,source,url,fit,timing';
  const metricCols = 'territory_id,hosts_active_28d,events_next_14d,sub_areas_covered_14d,wam';
  return (
    <div className="stack">
      <OpenRegion flow={flow} refresh={refresh} />
      <Upload title="Upload leads" columns={leadCols} send={flowAdmin.uploadLeads} refresh={refresh} />
      <Upload title="Upload metrics" columns={metricCols} send={flowAdmin.uploadMetrics} refresh={refresh}>
        You can add weeks_at_threshold and weeks_below.
      </Upload>
      <Leads flow={flow} refresh={refresh} />
      <Targets flow={flow} refresh={refresh} />
      <RawConfig refresh={refresh} />
      <AdminLog flow={flow} />
    </div>
  );
}

function OpenRegion({ flow, refresh }: Props) {
  const [confirming, setConfirming] = useState(false);
  const { busy, run, outcome } = useAction(refresh);
  const id = flow.decision.kind === 'propose_expansion' ? flow.decision.territory_id : undefined;
  if (!id) return null;
  const name = flow.territories.find((t) => t.id === id)?.name ?? id;
  const open = () => run(() => flowAdmin.openRegion(id)).then(() => setConfirming(false));
  return (
    <Panel title="Open the next region">
      <p>{flow.decision.summary}</p>
      {!confirming && (
        <Button variant="primary" onClick={() => setConfirming(true)}>
          Open {name}
        </Button>
      )}
      {confirming && (
        <div className="callout callout-attention stack">
          <p>
            Open {name}? It becomes the active region and new outreach moves there. You cannot undo this here.
          </p>
          <div className="row">
            <Button variant="primary" onClick={open} disabled={busy}>
              Yes, open {name}
            </Button>
            <Button variant="quiet" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {outcome}
    </Panel>
  );
}

type UploadProps = { title: string; columns: string; children?: ReactNode; refresh: () => void } & {
  send: (csv: string) => Promise<C.AdminUpload>;
};

function Upload({ title, columns, children, send, refresh }: UploadProps) {
  const [text, setText] = useState('');
  const { busy, run, outcome } = useAction(refresh);
  const said = (r: C.AdminUpload) => (
    <>
      <p>{`${r.added === undefined ? '' : `${r.added} added, `}${r.updated} updated, ${r.skipped.length} skipped.`}</p>
      {r.skipped.length > 0 && (
        <ul>
          {r.skipped.map((s) => (
            <li key={s.row}>{`Row ${s.row}: ${s.reason}`}</li>
          ))}
        </ul>
      )}
    </>
  );
  return (
    <Panel title={title}>
      <p className="muted">
        A CSV file with a header row: <span className="mono">{columns}</span>. {children}
      </p>
      <label className="field">
        <span className="field-label">Choose a CSV file</span>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => e.target.files?.[0]?.text().then(setText)}
        />
      </label>
      <label className="field">
        <span className="field-label">Or paste the CSV here</span>
        <textarea className="mono" rows={5} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <Button
        variant="primary"
        onClick={() => run(() => send(text), said)}
        disabledReason={busy ? 'Uploading.' : text.trim() ? null : 'Choose a file or paste CSV first.'}
      >
        Upload
      </Button>
      {outcome}
    </Panel>
  );
}

function Leads({ flow, refresh }: Props) {
  const region = (id: string) => flow.territories.find((t) => t.id === id)?.name ?? id;
  return (
    <Panel title="Leads">
      <p>
        <a className="btn" href={flowAdmin.leadsCsvUrl} download>
          Export leads (CSV)
        </a>
      </p>
      {flow.leads.length === 0 && <p className="muted">No leads yet. Upload some above.</p>}
      <ul className="plain-list" style={{ overflowWrap: 'anywhere' }}>
        {flow.leads.map((l) => (
          <LeadRow key={l.id} lead={l} where={region(l.territory_id)} refresh={refresh} />
        ))}
      </ul>
    </Panel>
  );
}

function LeadRow({ lead, where, refresh }: { lead: Lead; where: string; refresh: () => void }) {
  const [via, setVia] = useState<C.SendVia>(lead.send_via ?? 'founder_email');
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const { busy, run, outcome } = useAction(refresh);
  const markSent = () =>
    run(
      () => flowAdmin.markSent(lead.id, via),
      () => `Marked sent: ${ROUTES[via]}.`,
    );
  const block = () => run(() => flowAdmin.doNotContact(lead.id, reason.trim()));
  const blocked = lead.stage === 'blocked';
  const pick = (v: string) => setVia(v as C.SendVia);
  return (
    <li className="stack">
      <div>
        <strong>{lead.name}</strong>
        <span className="muted">{` · ${lead.kind} · ${where} · ${lead.stage.replaceAll('_', ' ')}`}</span>
      </div>
      {blocked && <p className="muted">On the do-not-contact list. Nothing can be marked sent.</p>}
      {!blocked && (
        <div className="row">
          <select aria-label={`Route for ${lead.name}`} value={via} onChange={(e) => pick(e.target.value)}>
            <option value="founder_email">{ROUTES.founder_email}</option>
            <option value="frequency">{ROUTES.frequency}</option>
          </select>
          <Button className="btn-small" onClick={markSent} disabled={busy}>
            Mark sent
          </Button>
          <Button className="btn-small" variant="quiet" onClick={() => setAsking(!asking)} disabled={busy}>
            Do not contact
          </Button>
        </div>
      )}
      {asking && !blocked && (
        <div className="row">
          <label className="field">
            <span className="field-label">Why should {lead.name} not be contacted?</span>
            <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <Button
            className="btn-small"
            variant="stop"
            onClick={block}
            disabledReason={busy ? 'Saving.' : reason.trim() ? null : 'Give a reason first.'}
          >
            Add to the do-not-contact list
          </Button>
        </div>
      )}
      {outcome}
    </li>
  );
}

function Targets({ flow, refresh }: Props) {
  const start = () => Object.fromEntries(TARGETS.map(([k]) => [k, String(flow.thresholds[k] ?? '')]));
  const [values, setValues] = useState<Record<string, string>>(start);
  const { busy, run, outcome } = useAction(refresh);
  const save = async () => {
    const cfg = await flowAdmin.config();
    const activation = { ...cfg.activation };
    for (const [k] of TARGETS) activation[k] = Number(values[k]);
    return flowAdmin.saveConfig({ ...cfg, activation });
  };
  const set = (k: string, v: string) => setValues({ ...values, [k]: v });
  return (
    <Panel title="Activation targets">
      <p className="muted">
        Targets scale with each region's population. Saving keeps the rest of the config.
      </p>
      {TARGETS.map(([k, label]) => (
        <label key={k} className="field">
          <span className="field-label">{label}</span>
          <input
            type="number"
            step="any"
            min="0"
            value={values[k] ?? ''}
            onChange={(e) => set(k, e.target.value)}
          />
        </label>
      ))}
      <Button
        variant="primary"
        onClick={() => run(save, () => 'Saved.')}
        disabledReason={busy ? 'Saving.' : null}
      >
        Save targets
      </Button>
      {outcome}
    </Panel>
  );
}

function RawConfig({ refresh }: { refresh: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const { busy, run, outcome } = useAction(refresh);
  const load = () => run(flowAdmin.config).then((c) => c && setText(JSON.stringify(c, null, 2)));
  const save = async () => {
    let parsed: C.FlowConfigJson;
    try {
      parsed = JSON.parse(text ?? '') as C.FlowConfigJson;
    } catch {
      throw new Error('That is not valid JSON. Check for a missing comma or quote.');
    }
    return flowAdmin.saveConfig(parsed);
  };
  const edit = (v: string) => setText(v);
  return (
    <Panel title="Edit raw config">
      <p className="muted">
        For regions, sub-areas and borders. fwd checks it all and saves nothing if a part is wrong.
      </p>
      {text === null && (
        <Button onClick={load} disabledReason={busy ? 'Loading.' : null}>
          Load the current config
        </Button>
      )}
      {text !== null && (
        <>
          <label className="field">
            <span className="field-label">Config (JSON)</span>
            <textarea
              className="mono"
              rows={16}
              spellCheck={false}
              value={text}
              onChange={(e) => edit(e.target.value)}
            />
          </label>
          <div className="row">
            <Button
              variant="primary"
              onClick={() => run(save, () => 'Saved.')}
              disabledReason={busy ? 'Saving.' : null}
            >
              Save config
            </Button>
            <Button variant="quiet" onClick={() => setText(null)}>
              Close without saving
            </Button>
          </div>
        </>
      )}
      {outcome}
    </Panel>
  );
}

function AdminLog({ flow }: { flow: C.FlowAdminView }) {
  const log = flow.admin_log ?? [];
  return (
    <Panel title="Admin log">
      {log.length === 0 && <p className="muted">No changes yet.</p>}
      <ul className="plain-list" style={{ overflowWrap: 'anywhere' }}>
        {log.map((e) => (
          <li key={`${e.at} ${e.action} ${e.summary}`}>
            <span className="muted">{when(e.at)}</span> {e.summary}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
