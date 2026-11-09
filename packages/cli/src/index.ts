export const PACKAGE = '@fw/cli';

export {
  ClientUnavailableError,
  type CoreClient,
  type CoreClientFactory,
  type CoreClientOptions,
  type DoctorReport,
  findProviders,
  findWorkspaceRoot,
  type GcReport,
  loadCoreClientFactory,
  type ProviderDecl,
} from './client.ts';
export { COMMANDS, helpText, main } from './main.ts';
export { EXIT, exitCodeFor, type Io, invocationCwd, POLICY_CODES, toCliError } from './output.ts';
