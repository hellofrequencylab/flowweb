// FW-C-070: the flow's admin tools on a page of their own, out of the daily Flows view. Uploads (leads and
// metrics CSV), Open the next region, Activation targets, Edit raw config and the Admin log.
import { api } from '../api/client';
import { useResource } from '../api/resource';
import { Link } from '../shell/router';
import { AsOf, ResourceView } from '../ui-kit/honest';
import { PageHead } from '../ui-kit/page';
import { FlowAdmin } from './FlowAdmin';

export function AdminPage() {
  const res = useResource('flow:neighborhood-activation', () => api.activationFlow(), ['runs', 'cards']);
  return (
    <>
      <PageHead
        overline="Growth · admin"
        title={`${res.data?.name ?? 'Neighborhood activation'} admin`}
        lede={
          <>
            Upload leads or metrics, open the next region, change targets, or edit the raw config. Every
            change is written to the admin log. <Link to="/flows">Back to the flow</Link>
            <span className="page-meta">
              <AsOf res={res} />
            </span>
          </>
        }
      />
      <ResourceView res={res} what="this flow">
        {(f) => (
          <div className="stack">
            <FlowAdmin flow={f} refresh={res.reload} />
          </div>
        )}
      </ResourceView>
    </>
  );
}
