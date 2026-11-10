import type { CoreClient } from '../client.ts';
import type { Io } from '../output.ts';

export interface CommandContext {
  client: CoreClient;
  io: Io;
  json: boolean;
  args: string[];
  opts: Record<string, string | undefined>;
  repoDir: string;
  /** --home, when given (resolved). */
  home?: string;
}

export interface Command {
  /** e.g. ['ledger', 'sync'] */
  path: string[];
  usage: string;
  summary: string;
  /** Positional arguments, in order (all required). */
  args: string[];
  /** Command options (besides the global ones). Options listed in `required` must be given. */
  options: string[];
  required?: string[];
  run(ctx: CommandContext): Promise<number>;
}
