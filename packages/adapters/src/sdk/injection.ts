// Heuristic flagging of text that tries to instruct the agent or the platform. Flagged text is
// recorded in run-result.injection_suspected and otherwise passed through untouched, as data.
// Nothing in the adapter ever acts on vendor output text.
import type { InjectionSuspected } from './types.ts';

const PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|rules|prompts?)\b/i,
  /\byou\s+are\s+now\s+(?:in\s+)?[a-z ]{0,20}(?:mode|admin|root|developer)\b/i,
  /<\/?\s*system\s*>/i,
  /\bnew\s+instructions\s*:/i,
  /\b(?:send|post|upload|exfiltrate)\s+(?:the\s+|all\s+)?(?:secrets?|keys?|credentials?|tokens?|env(?:ironment)?)\b/i,
  /\b(?:approve|merge)\s+(?:this|the)\s+(?:pr|pull request)\s+(?:yourself|now|immediately)\b/i,
];

const MAX_FLAGS = 20;

export function detectInjection(text: string, source: string, location: string): InjectionSuspected {
  const out: InjectionSuspected = [];
  for (const re of PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const start = Math.max(0, m.index - 40);
    const fragment = text.slice(start, start + 200);
    out.push({ source: source.slice(0, 120), fragment, location: location.slice(0, 300) });
  }
  return out;
}

export function appendInjection(into: InjectionSuspected, more: InjectionSuspected): void {
  for (const f of more) {
    if (into.length >= MAX_FLAGS) return;
    if (!into.some((x) => x.location === f.location && x.fragment === f.fragment)) into.push(f);
  }
}
