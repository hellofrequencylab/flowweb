// Ledger row ids and human row codes. The id is the code without hyphens, behind `lr_`
// (FW-C-019 <-> lr_FWC019, WS-P1-001 <-> lr_WSP1001), because ids must match ^lr_[0-9A-Za-z]{4,40}$.

const FWC = /^lr_FWC(\d{3})$/;
const WSP = /^lr_WSP(\d+)(\d{3})$/;

/**
 * The human code of a ledger row id. Ids of the two known shapes get their hyphens back; any other
 * `lr_` id has no recorded hyphenation, so its code is the id without the prefix. Null for null.
 */
export function rowCodeOf(id: string | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  const f = FWC.exec(id);
  if (f) return `FW-C-${f[1]}`;
  const w = WSP.exec(id);
  if (w) return `WS-P${w[1]}-${w[2]}`;
  return id.startsWith('lr_') ? id.slice(3) : id;
}

/** Accepts either an `lr_` id or a code (FW-C-019) and returns the id. */
export function rowIdOf(idOrCode: string): string {
  if (idOrCode.startsWith('lr_')) return idOrCode;
  return `lr_${idOrCode.replace(/-/g, '')}`;
}
