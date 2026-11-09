export const PACKAGE = '@fw/policy';

export {
  CORE_TIER0_PATHS,
  type DiffPolicyInput,
  type DiffRule,
  type DiffVerdict,
  type DiffViolation,
  diffHash,
  evaluateDiffPolicy,
  globToRegExp,
  type PathChange,
  parseNameStatus,
} from './diff-policy.ts';
