// FW-C-071: is a sender on this Mac reading the outbox? The sender (senders/email.mjs, outside Core)
// writes $FW_HOME/senders/email/last-pass.json at the end of every pass that loaded its settings.
// fwd only reads that file. installed means a pass ran in the last 24 hours; last_pass_at is shown
// even when it is older, so the page can say when the sender last ran.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SENDER_FRESH_MS = 24 * 3600e3;

export interface SenderStatus {
  installed: boolean;
  last_pass_at: string | null;
}

export function senderStatus(fwHome: string, now: Date = new Date()): SenderStatus {
  let at: string | null = null;
  try {
    const beat = JSON.parse(readFileSync(join(fwHome, 'senders', 'email', 'last-pass.json'), 'utf8')) as {
      at?: unknown;
    };
    if (typeof beat?.at === 'string' && Number.isFinite(Date.parse(beat.at))) at = beat.at;
  } catch {
    // No heartbeat (or an unreadable one): no sender has run here.
  }
  const age = at === null ? Number.POSITIVE_INFINITY : now.getTime() - Date.parse(at);
  return { installed: age < SENDER_FRESH_MS, last_pass_at: at };
}
