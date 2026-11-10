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
  isDependencyManifest,
  type PathChange,
  parseNameStatus,
} from './diff-policy.ts';
export {
  DIFF_POLICY_RULES_PATH,
  type DiffPolicyRules,
  dependencyNames,
  loadDiffPolicyRules,
  type ManifestContent,
  type PatchFile,
  parseDiffPolicyRules,
  parsePatch,
  type RowSize,
} from './diff-rules.ts';
export {
  type ApplyReport,
  applyPolicy,
  type Decision,
  type DecisionInput,
  decide,
  enforce,
  findPolicy,
  loadPolicy,
  type Policy,
  type PolicyRule,
  policyCandidates,
  TIERS,
  type Tier,
} from './engine/index.ts';
