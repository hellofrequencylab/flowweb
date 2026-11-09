import type { AdapterErrorCode } from './types.ts';

/** Typed adapter failure. Preflight and start-up checks throw this; the run engine turns it into a refusal. */
export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  constructor(code: AdapterErrorCode, message: string) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
  }
}

export function isAdapterError(e: unknown): e is AdapterError {
  return e instanceof AdapterError;
}
