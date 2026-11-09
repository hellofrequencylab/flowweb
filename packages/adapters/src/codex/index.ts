// Codex exec adapter: out of scope for milestone C0 (ledger row WS-P1-015, milestone C1).
import type { VendorAdapter } from '../sdk/types.ts';

export function createCodexAdapter(): VendorAdapter {
  throw new Error('codex adapter: not implemented in C0 (row WS-P1-015, milestone C1)');
}
