// Defensive parser for `claude -p --output-format stream-json --verbose` output. Each stdout line
// is one JSON event with a `type`. Known types: system (subtype init), assistant, user, result.
// Everything else (partial message chunks, hook events, rate-limit notices, future types) is
// ignored. Unknown fields are ignored. A line that is not a JSON object becomes a typed error.
import { count, type TokenUsage } from '../sdk/cost.ts';
import type { LineParser, VendorItem } from '../sdk/engine.ts';
import { parseJsonObject } from '../sdk/lines.ts';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Claude usage: cache creation is billed as input; cache reads are the cached bucket. */
export function claudeUsage(v: unknown): TokenUsage | undefined {
  if (!isObj(v)) return undefined;
  return {
    input_tokens: count(v.input_tokens) + count(v.cache_creation_input_tokens),
    output_tokens: count(v.output_tokens),
    cached_tokens: count(v.cache_read_input_tokens),
  };
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (isObj(c) && c.type === 'text' && typeof c.text === 'string') return c.text;
        if (isObj(c) && typeof c.type === 'string') return `[${c.type}]`;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function createClaudeParser(): LineParser {
  return (line: string): VendorItem[] => {
    const ev = parseJsonObject(line);
    if (!ev)
      return [
        { kind: 'error', code: 'malformed_line', message: 'stdout line is not a JSON object', raw: line },
      ];
    const bad = (what: string): VendorItem[] => [
      {
        kind: 'error',
        code: 'unexpected_shape',
        message: `claude ${String(ev.type)} event: ${what}`,
        raw: line,
      },
    ];
    switch (ev.type) {
      case 'system': {
        if (ev.subtype !== 'init') return [];
        if (typeof ev.session_id !== 'string' || !ev.session_id) return bad('init without session_id');
        return [
          {
            kind: 'session',
            session_id: ev.session_id,
            ...(typeof ev.model === 'string' ? { model: ev.model } : {}),
          },
        ];
      }
      case 'assistant': {
        const msg = ev.message;
        if (!isObj(msg) || !Array.isArray(msg.content)) return bad('message.content is not an array');
        const items: VendorItem[] = [];
        const texts: string[] = [];
        const calls: VendorItem[] = [];
        for (const block of msg.content) {
          if (!isObj(block)) continue;
          if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
          else if (block.type === 'tool_use') {
            if (typeof block.id !== 'string' || typeof block.name !== 'string') {
              items.push(...bad('tool_use without id or name'));
              continue;
            }
            calls.push({ kind: 'tool_call', id: block.id, name: block.name, input: block.input ?? null });
          }
          // thinking, redacted_thinking and future block types are not recorded.
        }
        const usage = claudeUsage(msg.usage);
        items.push({
          kind: 'turn',
          text: texts.join('\n'),
          ...(typeof msg.id === 'string' ? { message_id: msg.id } : {}),
          ...(usage ? { usage } : {}),
        });
        items.push(...calls);
        return items;
      }
      case 'user': {
        const msg = ev.message;
        if (!isObj(msg)) return bad('message is not an object');
        if (!Array.isArray(msg.content)) return [];
        const items: VendorItem[] = [];
        for (const block of msg.content) {
          if (!isObj(block) || block.type !== 'tool_result') continue;
          if (typeof block.tool_use_id !== 'string') {
            items.push(...bad('tool_result without tool_use_id'));
            continue;
          }
          items.push({
            kind: 'tool_result',
            id: block.tool_use_id,
            text: toolResultText(block.content),
            is_error: block.is_error === true,
          });
        }
        return items;
      }
      case 'result': {
        const usage = claudeUsage(ev.usage);
        const subtype = typeof ev.subtype === 'string' ? ev.subtype : 'unknown';
        return [
          {
            kind: 'result',
            ok: subtype === 'success' && ev.is_error !== true,
            subtype,
            ...(typeof ev.total_cost_usd === 'number' ? { usd: ev.total_cost_usd } : {}),
            ...(usage ? { usage } : {}),
            ...(typeof ev.session_id === 'string' && ev.session_id ? { session_id: ev.session_id } : {}),
            ...(typeof ev.result === 'string' ? { summary: ev.result } : {}),
            report: ev.structured_output,
          },
        ];
      }
      default:
        return [];
    }
  };
}
