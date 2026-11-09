export const PACKAGE = '@fw/daemon';

export { rowCodeOf, rowIdOf } from './api/codes.ts';
export {
  type Daemon,
  type DaemonOptions,
  DEFAULT_PORT,
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
  type PrState,
  type PrStatus,
  type PullRequestRef,
  type PushResult,
  type Runner,
  type TokenScopeReport,
} from './edge-git/index.ts';
export { ORPHAN_STATES, type ReconcileReport, reconcileOnStart } from './reconciler.ts';
export {
  type ArtifactCheck,
  type ArtifactGuardInput,
  type ArtifactReason,
  checkRunArtifact,
} from './runtime/artifact-guard.ts';
export { branchChanges } from './runtime/branch-diff.ts';
export {
  ExecError,
  type ExecOptions,
  type ExecResult,
  execArgv,
  execOk,
  git,
  gitEnv,
} from './runtime/exec.ts';
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
