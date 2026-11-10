/**
 * FW-C-096: a flow rolled into another (its config.json says merged_into) still ships, so fwd lists it,
 * but the site shows only the flow it was merged into.
 */
export function liveFlows<T extends { merged_into?: string | null }>(flows: T[]): T[] {
  return flows.filter((f) => !f.merged_into);
}
