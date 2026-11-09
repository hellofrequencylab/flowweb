import { AsOf } from '../ui-kit/honest';
import { PageHead } from '../ui-kit/page';
import { EvidenceView, useDiff, useEvidence } from './EvidenceView';

export function EvidencePage({ id }: { id: string }) {
  const ev = useEvidence(id);
  const diff = useDiff(id);
  return (
    <>
      <PageHead
        title={<>Evidence {id}</>}
        lede={
          <span className="page-meta">
            <AsOf res={ev} />
          </span>
        }
      />
      {ev.data && <p className="muted">{ev.data.subject.ref}</p>}
      <EvidenceView ev={ev} diff={diff} />
    </>
  );
}
