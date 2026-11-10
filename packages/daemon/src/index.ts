export const PACKAGE = '@fw/daemon';

export { rowCodeOf, rowIdOf } from './api/codes.ts';
export {
  CredentialError,
  type CredentialErrorCode,
  type CredentialRequest,
  credentialFilePath,
  HANDLE_RE,
  type InjectedCredentials,
  injectCredentials,
  KEYCHAIN_SERVICE,
  ResolvedCredential,
  redactLiterals,
  resolveCredential,
  resolveCredentialHandle,
} from './creds/index.ts';
export {
  type Daemon,
  type DaemonOptions,
  DEFAULT_PORT,
  DEFAULT_STOP_TIMEOUT_MS,
  ensureFwHome,
  HOME_DIRS,
  LOOPBACK,
  startDaemon,
} from './daemon.ts';
export {
  assertBranchName,
  GhHost,
  type GhHostLogEntry,
  type GhHostOptions,
  type GitHost,
  GitHostError,
  LocalBareHost,
  type OpenPullRequestInput,
  type PrListing,
  type PrState,
  type PrStatus,
  type PullRequestRef,
  type PushResult,
  type Runner,
  type TokenScopeReport,
} from './edge-git/index.ts';
export {
  FwdUnreachableError,
  fwdEndpoint,
  fwdError,
  fwdRequest,
} from './fwd-client.ts';
export {
  createCoreClient,
  type DaemonCoreClient,
  type RunStartRequest,
  type StatusReport,
} from './local-client.ts';
export {
  buildEvidenceBundle,
  type EvidenceInput,
  evidenceBundleHash,
  prComment,
} from './pipeline/evidence.ts';
export { listRuns, type RunDetail, RunNotFoundError, type RunSummary, showRun } from './pipeline/queries.ts';
export { endRun, releaseLeases, settleRowAfterFailure } from './pipeline/records.ts';
export {
  hostRepoOf,
  PipelineError,
  type RunStartOptions,
  type RunStartReport,
  resolveGitHost,
  runStart,
} from './pipeline/run-start.ts';
export {
  type Breach,
  type SupervisedOutcome,
  type SupervisedRun,
  type SuperviseOptions,
  startSupervised,
  supervise,
} from './pipeline/supervisor.ts';
export { type DriftItem, type GitReconcileReport, reconcileGitHost } from './reconcile-git.ts';
export { ORPHAN_STATES, type ReconcileReport, reconcileOnStart } from './reconciler.ts';
export { RunHost, RunHostStoppingError } from './run-host.ts';
export {
  type ArtifactCheck,
  type ArtifactGuardInput,
  type ArtifactReason,
  checkRunArtifact,
} from './runtime/artifact-guard.ts';
export { branchChanges } from './runtime/branch-diff.ts';
export { DOCTOR_RUN_PREFIX, type DoctorReport, runDoctor } from './runtime/doctor.ts';
export {
  ExecError,
  type ExecOptions,
  type ExecResult,
  execArgv,
  execOk,
  git,
  gitEnv,
} from './runtime/exec.ts';
export { type GcEntry, type GcReport, gcRunDirs, TERMINAL_RUN_STATES } from './runtime/gc.ts';
export {
  assertRowId,
  assertRunId,
  isInside,
  ROW_ID_RE,
  RUN_ID_RE,
  resolveFwHome,
  runScopedPath,
  UnsafePathError,
} from './runtime/paths.ts';
export { type QuarantineResult, quarantineBranch, quarantineBranchName } from './runtime/quarantine.ts';
export {
  type BuildEnvInput,
  buildSandboxEnv,
  type ControlLevel,
  type ControlName,
  type ControlResult,
  DEFAULT_ENV_ALLOWLIST,
  killProcessGroup,
  type PrepareSandboxInput,
  parseEgressAllow,
  prepareSandbox,
  removeRunDir,
  type Sandbox,
  type SandboxMode,
  type SandboxSettings,
  type SelfTestReport,
  sandboxSelfTest,
  sandboxSettingsFromEnv,
  spawnInSandbox,
  weakestLevel,
} from './runtime/sandbox.ts';
export { AGENT_INSTRUCTION_FILES, TIER0_PATHS } from './runtime/tier0.ts';
export {
  type CreateWorktreeResult,
  type PruneResult,
  parseRunBranch,
  type RemoveWorktreeResult,
  RUN_BRANCH_PREFIX,
  runBranchName,
  type WorktreeInfo,
  WorktreeManager,
  type WorktreeManagerOptions,
} from './runtime/worktrees.ts';
export { type Cron, CronError, parseCron } from './scheduler/cron.ts';
export {
  createScheduler,
  type FireRecord,
  type FireRequest,
  type FireVerdict,
  type OnFire,
  type Scheduler,
  type SchedulerClock,
  type SchedulerOptions,
  systemClock,
} from './scheduler/index.ts';
export {
  SPEND_GROUP_NAMES,
  type SpendGroup,
  type SpendQuery,
  type SpendRow,
  spendRollup,
} from './spend.ts';
export {
  buildDigest,
  checkDigest,
  type DigestCheck,
  type DigestLine,
  type DigestOptions,
  type DigestProblem,
  type DigestReport,
  type PublishOptions,
  type PublishResult,
  publishDigest,
} from './streams/digest/index.ts';
