import { api } from '../api/client';
import { useResource } from '../api/resource';
import { Link } from '../shell/router';
import { AsOf, Empty, ResourceView } from '../ui-kit/honest';
import { PageHead } from '../ui-kit/page';
import { age, useNow } from '../ui-kit/time';

const n = (v: number | undefined) => (v === undefined ? <span className="fact-unknown">Unknown</span> : v);

export function ProjectsSummary() {
  const res = useResource('projects', api.projects, ['rows', 'runs']);
  const now = useNow();
  return (
    <ResourceView res={res} what="projects">
      {(d) =>
        d.projects.length === 0 ? (
          <Empty title="No projects yet">
            Add one with <code>fw</code>.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Status</th>
                  <th className="num">Open</th>
                  <th className="num">In progress</th>
                  <th className="num">Waiting on you</th>
                  <th className="hide-narrow">Last run</th>
                </tr>
              </thead>
              <tbody>
                {d.projects.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.name}</strong>
                      {p.repo && (
                        <div className="xs muted">{p.repo.replace(/^https:\/\/github.com\//, '')}</div>
                      )}
                    </td>
                    <td>
                      {p.status === 'active' ? 'Active' : p.status === 'paused' ? 'Paused' : 'Archived'}
                    </td>
                    <td className="num">{n(p.rows_open)}</td>
                    <td className="num">{n(p.rows_in_progress)}</td>
                    <td className="num">
                      {p.rows_waiting_on_owner ? (
                        <Link to="/ledger?status=awaiting_approval">{p.rows_waiting_on_owner}</Link>
                      ) : (
                        n(p.rows_waiting_on_owner)
                      )}
                    </td>
                    <td className="hide-narrow">{p.last_run_at ? age(p.last_run_at, now) : 'none'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
    </ResourceView>
  );
}

export function ProjectsPage() {
  const res = useResource('projects', api.projects, ['rows', 'runs']);
  return (
    <>
      <PageHead
        title={<>Projects</>}
        lede={
          <>
            Repositories FlowWeb works in.
            <span className="page-meta">
              <AsOf res={res} />
            </span>
          </>
        }
      />
      <ProjectsSummary />
      <p>
        <Link to="/ledger">Open Logs</Link>
      </p>
    </>
  );
}
