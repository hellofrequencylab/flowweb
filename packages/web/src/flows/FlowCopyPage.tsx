// FW-C-156: the page of one flow copy (a profile flow such as Coaches and Guides). It shows the copy's own
// drafts, hunts and settings; the base flow keeps its longer page.
import { api } from '../api/client';
import { useResource } from '../api/resource';
import { PageHead } from '../ui-kit/page';
import { DraftsInbox } from './DraftsInbox';
import { FlowControls } from './FlowControls';
import { FlowHero } from './FlowHero';
import { LeadHunts } from './LeadHunts';
import { ReplyHelper } from './ReplyHelper';
import { TargetingEditor } from './TargetingEditor';
import { Today } from './Today';

export const isCopyKey = (key: string | undefined): key is string => !!key && key.indexOf('--') > 0;

export function FlowCopyPage({ flow }: { flow: string }) {
  const sup = useResource('supervisor', () => api.supervisor(), ['runs', 'cards']);
  const view = useResource(`flow:${flow}`, () => api.activationFlow(flow), ['runs', 'cards']);
  const f = sup.data?.flows.find((x) => x.key === flow);
  const regions = (view.data?.territories ?? []).map((t) => ({ id: t.id, name: t.name }));
  return (
    <>
      <PageHead
        overline="Flow · drafts only"
        title={f?.name ?? flow}
        lede={
          f?.note ??
          'Finds people for one Frequency profile and drafts a note to each. You read, edit and send every one.'
        }
      />
      <FlowHero flowKey={flow} />
      <div className="flow-ctl">
        <FlowControls only={flow} />
      </div>
      <div className="stack flows-page">
        <Today flow={flow} />
        <DraftsInbox flow={flow} />
        <TargetingEditor flow={flow} />
        <LeadHunts regions={regions} flow={flow} />
        <ReplyHelper flow={flow} />
      </div>
    </>
  );
}
