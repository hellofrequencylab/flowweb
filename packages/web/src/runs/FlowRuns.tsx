import type { FlowRun } from '../api/types';
import { Link } from '../shell/router';
import { StatusLabel, type StatusSpec } from '../ui-kit/status';
import { duration, useNow, when } from '../ui-kit/time';

/** "neighborhood-activation" → "Neighborhood activation"; the digest is "Daily digest". */
export function flowName(r: FlowRun): string {
  if (r.kind === 'digest') return 'Daily digest';
  const s = r.flow.replace(/[-_]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : 'Flow';
}

export const FLOW_OUTCOME: Record<FlowRun['outcome'], StatusSpec> = {
  drafted: { word: 'Drafted', tone: 'ok', icon: 'pass' },
  dry: { word: 'Nothing drafted', tone: 'neutral', icon: 'skipped' },
  failed: { word: 'Failed', tone: 'fail', icon: 'fail' },
  published: { word: 'Published', tone: 'ok', icon: 'pass' },
  unknown: { word: 'Unknown outcome', tone: 'unknown', icon: 'notverified' },
};

/** Which Runs page status filter a flow run falls under: it ran fine, or it failed. */
export function flowFilterKey(r: FlowRun): string {
  if (r.outcome === 'failed') return 'failed';
  return r.outcome === 'unknown' ? '' : 'succeeded';
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function what(r: FlowRun): string | undefined {
  if (r.outcome === 'drafted') return plural(r.drafts, 'draft');
  if (r.outcome === 'failed') return r.reason;
  return undefined;
}

/** FW-C-075: flow cycles and digests, which fwd records as reports rather than agent runs. */
export function FlowRunsTable({ runs }: { runs: FlowRun[] }) {
  const now = useNow(15_000);
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Flow</th>
            <th>What it did</th>
            <th className="num">Leads found</th>
            <th className="hide-narrow">Engine</th>
            <th className="hide-narrow">Started</th>
            <th className="hide-narrow num">Took</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>{r.kind === 'cycle' ? <Link to="/flows">{flowName(r)}</Link> : flowName(r)}</td>
              <td>
                <StatusLabel spec={FLOW_OUTCOME[r.outcome]} detail={what(r)} />
              </td>
              <td className="num">{r.found ? `${r.found} found` : ''}</td>
              <td className="hide-narrow">{r.engine ?? ''}</td>
              <td className="hide-narrow">{when(r.started_at, now)}</td>
              <td className="hide-narrow num">
                {r.kind === 'cycle' ? duration(r.started_at, r.ended_at, now) : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
