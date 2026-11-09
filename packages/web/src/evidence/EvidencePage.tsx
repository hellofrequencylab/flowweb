import { AsOf } from '../ui-kit/honest';
import { PageHead } from '../ui-kit/page';
import { EvidenceView, useDiff, useEvidence } from './EvidenceView';

export function EvidencePage({ id }: { id: string }) {
  const ev = useEvidence(id);
  const diff = useDiff(id);
  return (
    <>
      <PageHead
        overline="Evidence bundle"
        title={<span className="mono-title">{id}</span>}
        lede={
          <>
            {ev.data ? <>For {ev.data.subject.ref}</> : null}
            <span className="page-meta">
              <AsOf res={ev} />
            </span>
          </>
        }
      />
      <EvidenceView ev={ev} diff={diff} />
    </>
  );
}
