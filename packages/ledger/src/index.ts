export const PACKAGE = '@fw/ledger';

export {
  type Actor,
  BACKLOG_STREAM_KEY,
  type Bootstrap,
  DEFAULT_AGENTS,
  ensureBootstrap,
  findBootstrap,
  ownerActor,
  ownerId,
  type ProjectConfig,
} from './bootstrap.ts';
export {
  bundleHash,
  type CloseOptions,
  type CloseReport,
  closeEvidenceBundle,
  closeRow,
  type ProbeEvidence,
} from './close.ts';
export {
  type CreateDecisionItemInput,
  createDecisionItem,
  DECISION_STATUSES,
  DECISION_VARIANTS,
  type DecisionItem,
  type DecisionOptions,
  type DecisionStatus,
  type DecisionVariant,
  type ExpiredDecisionItem,
  expireDecisionItems,
  listDecisionItems,
} from './decisions/index.ts';
export {
  contractProbe,
  DEFAULT_PROBE_TIMEOUT_S,
  type DefinitionCheck,
  type ProbeDefinition,
  parseRowDefinition,
  probeArgv,
  probeFromDefinition,
  probeHash,
  type RowDefinition,
} from './definition.ts';
export { LedgerError, type LedgerErrorCode, surfaceDbRefusal } from './errors.ts';
export {
  isLegalTransition,
  LEDGER_TRANSITIONS,
  ROW_STATUSES,
  type TransitionOptions,
  type TransitionResult,
  transitionRow,
} from './fsm.ts';
export { gitHead, gitTrackedClean } from './git.ts';
export { analyzeGraph, type GraphReport } from './graph.ts';
export { dbPath, loadHomeConfig, resolveHome, resolveProject } from './home.ts';
export { codeFromRowId, isRowCode, resolveRowId, rowIdFromCode } from './ids.ts';
export {
  type AcquireLeaseInput,
  acquireLease,
  checkFence,
  heartbeatLease,
  LeaseError,
  type LeaseErrorCode,
  type LeaseGrant,
  type LeaseOptions,
  releaseLease,
} from './leases/index.ts';
export { createCoreClient, type LocalClientOptions, type LocalCoreClient } from './local-client.ts';
export { type CorePolicy, loadCorePolicy, type SizeRule } from './policy.ts';
export { type PremiseOptions, type PremiseOutcome, type PremiseReport, retestPremise } from './premise.ts';
export {
  checkedProbe,
  checkProbeManifest,
  type ExecuteOptions,
  executeCommandProbe,
  type ManifestCheck,
  type ManifestProblem,
  OUTPUT_TAIL_BYTES,
  PROBE_MANIFEST,
  type ProbeRunResult,
  type ProbeStatus,
  parseManifest,
  probeFilesOf,
  type RecordedProbe,
  type RunRowProbeOptions,
  recordProbeResult,
  runnableProbe,
  runRowProbe,
  type TargetKind,
} from './probe.ts';
export {
  findProject,
  type LabelChange,
  type LabelReport,
  labelProject,
  listProjects,
  PROJECT_CATEGORIES,
  PROJECT_LABELS_KEY,
  type ProjectCategory,
  type ProjectFilter,
  type ProjectLabels,
  type ProjectView,
  readLabels,
} from './projects/labels.ts';
export {
  type EvidenceView,
  type ListFilter,
  listRows,
  nextRow,
  type RowDetail,
  retestCandidates,
  showRow,
} from './queries.ts';
export {
  findQuery,
  QUERIES,
  type QueryParams,
  type QueryResult,
  type RegisteredQuery,
  runQuery,
} from './queries/index.ts';
export {
  type DbRow,
  getDbRow,
  type RowStatus,
  type RowView,
  storedProbe,
  toContract,
  toView,
} from './rows.ts';
export {
  type RefusalReason,
  rowContract,
  type SyncOptions,
  type SyncRefusal,
  type SyncReport,
  syncRows,
} from './sync.ts';
export {
  ALWAYS_FORBIDDEN,
  assertNotSelfVerify,
  type CompileInput,
  compileWorkOrder,
  dispatchRule,
  workOrderHash,
} from './workorder/compile.ts';
export { type IssueOptions, type IssueReport, issueWorkOrder } from './workorder/issue.ts';
