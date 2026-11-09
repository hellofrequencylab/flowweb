// Row codes and database ids. A row code is the human name (FW-C-019, WS-P0-016); the database id is
// 'lr_' + the code without hyphens (lr_FWC019), because ids must match ^lr_[0-9A-Za-z]{4,40}$.
// The code grammar is narrow on purpose so that every id maps back to exactly one code.
import { LedgerError } from './errors.ts';

const CODE_RE = /^([A-Z]{2})-([A-Z][0-9]?)-([0-9]{3})$/;
const ID_RE = /^lr_([A-Z]{2})([A-Z][0-9]?)([0-9]{3})$/;

export function isRowCode(s: string): boolean {
  return CODE_RE.test(s);
}

/** FW-C-019 -> lr_FWC019. Throws BAD_ARGUMENT for a string that is not a row code. */
export function rowIdFromCode(code: string): string {
  const m = CODE_RE.exec(code);
  if (!m)
    throw new LedgerError('BAD_ARGUMENT', `not a row code (expected e.g. FW-C-019 or WS-P0-016): ${code}`);
  return `lr_${m[1]}${m[2]}${m[3]}`;
}

/** lr_FWC019 -> FW-C-019. An id outside the code grammar comes back without its prefix. */
export function codeFromRowId(id: string): string {
  const m = ID_RE.exec(id);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : id.replace(/^lr_/, '');
}

/** Accepts a row code or a database id and returns the database id. */
export function resolveRowId(codeOrId: string): string {
  if (codeOrId.startsWith('lr_')) return codeOrId;
  return rowIdFromCode(codeOrId);
}
