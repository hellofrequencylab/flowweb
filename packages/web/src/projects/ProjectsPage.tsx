import { api } from '../api/client';
import { useResource } from '../api/resource';
import type { Project } from '../api/types';
import { Link, useRouter } from '../shell/router';
import { AsOf, Empty, ResourceView } from '../ui-kit/honest';
import { PageHead } from '../ui-kit/page';
import { age, useNow } from '../ui-kit/time';

const n = (v: number | undefined) => (v === undefined ? <span className="fact-unknown">Unknown</span> : v);

export const CATEGORIES = ['marketing', 'product', 'ops', 'sales', 'support', 'finance', 'other'] as const;
const CATEGORY_WORD: Record<string, string> = {
  marketing: 'Marketing',
  product: 'Product',
  ops: 'Ops',
  sales: 'Sales',
  support: 'Support',
  finance: 'Finance',
  other: 'Other',
};
const categoryWord = (c: string) => CATEGORY_WORD[c] ?? c;

type GroupBy = 'brand' | 'category' | 'none';
const NONE_LABEL = { brand: 'No brand', category: 'No category' } as const;

/** Same brand regardless of case or outer spaces, as fwd compares them. */
const brandKey = (b: string | null) => (b ?? '').trim().toLowerCase();

/** Groups in alphabetical order, unlabelled projects last. */
export function groupProjects(projects: Project[], by: 'brand' | 'category'): [string, Project[]][] {
  const groups = new Map<string, { label: string; items: Project[] }>();
  for (const p of projects) {
    const key = by === 'brand' ? brandKey(p.brand) : (p.category ?? '');
    const label = key === '' ? '' : by === 'brand' ? (p.brand ?? '').trim() : categoryWord(key);
    const g = groups.get(key) ?? { label, items: [] };
    g.items.push(p);
    groups.set(key, g);
  }
  const named = [...groups]
    .filter(([k]) => k !== '')
    .sort(([, a], [, b]) => a.label.localeCompare(b.label))
    .map(([, g]) => [g.label, g.items] as [string, Project[]]);
  const none = groups.get('');
  return none ? [...named, [NONE_LABEL[by], none.items]] : named;
}

function Labels({ p }: { p: Project }) {
  const parts = [p.brand, p.category ? categoryWord(p.category) : null].filter(Boolean);
  return parts.length ? <div className="xs muted">{parts.join(' · ')}</div> : null;
}

function ProjectRow({ p, now }: { p: Project; now: number }) {
  return (
    <tr>
      <td>
        <strong>{p.name}</strong>
        <Labels p={p} />
        {p.repo && <div className="xs muted">{p.repo.replace(/^https:\/\/github.com\//, '')}</div>}
      </td>
      <td>{p.status === 'active' ? 'Active' : p.status === 'paused' ? 'Paused' : 'Archived'}</td>
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
  );
}

/** One table, so columns line up; when grouped, each group is its own tbody under a heading row. */
function ProjectsTable({ groups }: { groups: [string | null, Project[]][] }) {
  const now = useNow();
  return (
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
        {groups.map(([label, items]) => (
          <tbody key={label ?? ''}>
            {label !== null && (
              <tr>
                <th colSpan={6} scope="rowgroup" className="group-head">
                  {label} <span className="muted">· {items.length}</span>
                </th>
              </tr>
            )}
            {items.map((p) => (
              <ProjectRow key={p.id} p={p} now={now} />
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

const NO_PROJECTS = (
  <Empty title="No projects yet">
    Add one with <code>fw</code>.
  </Empty>
);

export function ProjectsSummary() {
  const res = useResource('projects', api.projects, ['rows', 'runs']);
  return (
    <ResourceView res={res} what="projects">
      {(d) => (d.projects.length === 0 ? NO_PROJECTS : <ProjectsTable groups={[[null, d.projects]]} />)}
    </ResourceView>
  );
}

export function ProjectsPage() {
  const res = useResource('projects', api.projects, ['rows', 'runs']);
  const { loc, go } = useRouter();
  const brand = loc.query.get('brand') ?? '';
  const category = loc.query.get('category') ?? '';
  const groupParam = loc.query.get('group');
  const group: GroupBy = groupParam === 'category' || groupParam === 'none' ? groupParam : 'brand';

  const setFilter = (k: string, v: string) => {
    const q = new URLSearchParams(loc.query);
    if (v) q.set(k, v);
    else q.delete(k);
    go(`/projects${q.toString() ? `?${q}` : ''}`);
  };

  return (
    <>
      <PageHead
        title={<>Projects</>}
        lede={
          <>
            What FlowWeb works on, by brand and category.
            <span className="page-meta">
              <AsOf res={res} />
            </span>
          </>
        }
      />
      <ResourceView res={res} what="projects">
        {(d) => {
          if (d.projects.length === 0) return NO_PROJECTS;
          const brands = groupProjects(
            d.projects.filter((p) => p.brand),
            'brand',
          ).map(([label]) => label);
          const shown = d.projects.filter(
            (p) =>
              (!brand || (brand === '-' ? !p.brand : brandKey(p.brand) === brandKey(brand))) &&
              (!category || (category === '-' ? !p.category : p.category === category)),
          );
          return (
            <>
              <fieldset className="filters">
                <legend className="visually-hidden">Filters</legend>
                <label>
                  Brand
                  <select value={brand} onChange={(e) => setFilter('brand', e.target.value)}>
                    <option value="">All</option>
                    {brands.map((b) => (
                      <option key={b}>{b}</option>
                    ))}
                    <option value="-">No brand</option>
                  </select>
                </label>
                <label>
                  Category
                  <select value={category} onChange={(e) => setFilter('category', e.target.value)}>
                    <option value="">All</option>
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {categoryWord(c)}
                      </option>
                    ))}
                    <option value="-">No category</option>
                  </select>
                </label>
                <label>
                  Group by
                  <select
                    value={group}
                    onChange={(e) => setFilter('group', e.target.value === 'brand' ? '' : e.target.value)}
                  >
                    <option value="brand">Brand</option>
                    <option value="category">Category</option>
                    <option value="none">Nothing</option>
                  </select>
                </label>
              </fieldset>
              <p className="small muted">
                {shown.length} of {d.projects.length} projects. Label one with{' '}
                <code>fw project label &lt;project&gt; --brand &lt;name&gt; --category &lt;category&gt;</code>
                .
              </p>
              {shown.length === 0 ? (
                <Empty title="No projects match">Nothing matches these filters.</Empty>
              ) : (
                <ProjectsTable groups={group === 'none' ? [[null, shown]] : groupProjects(shown, group)} />
              )}
            </>
          );
        }}
      </ResourceView>
      <p>
        <Link to="/ledger">Open Logs</Link>
      </p>
    </>
  );
}
