import { AsOf } from '../ui-kit/honest';
import { EvidenceView, useDiff, useEvidence } from './EvidenceView';

export function EvidencePage({ id }: { id: string }) {
  const ev = useEvidence(id);
  const diff = useDiff(id);
  return (
    <>
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h1 tabIndex={-1}>Evidence {id}</h1>
        <span className="spacer" />
        <AsOf res={ev} />
      </div>
      {ev.data && <p className="muted">{ev.data.subject.ref}</p>}
      <EvidenceView ev={ev} diff={diff} />
    </>
  );
}
