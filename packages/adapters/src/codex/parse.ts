// Defensive parser for `codex exec --json` output. Each stdout line is one JSON event with a `type`:
// thread.started, turn.started, item.started / item.updated / item.completed, turn.completed,
// turn.failed and error. Everything else is ignored, as are unknown fields and item types.
// Top-level `error` events are retry notices ("Reconnecting...") and are not fatal; a failed turn
// arrives as turn.failed. A line that is not a JSON object becomes a typed error.
import { count, type TokenUsage } from '../sdk/cost.ts';
import type { LineParser, VendorItem } from '../sdk/engine.ts';
import { parseJsonObject } from '../sdk/lines.ts';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Codex usage: input_tokens includes the cached ones, so the cached share is moved out. */
export function codexUsage(v: unknown): TokenUsage | undefined {
  if (!isObj(v)) return undefined;
  const cached = count(v.cached_input_tokens);
  return {
    input_tokens: Math.max(0, count(v.input_tokens) - cached),
    output_tokens: count(v.output_tokens),
    cached_tokens: cached,
  };
}

function parseReport(text: string): unknown {
  const t = text.trim();
  if (!t.startsWith('{')) return undefined;
  try {
    const v = JSON.parse(t) as unknown;
    return isObj(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export function createCodexParser(): LineParser {
  let threadId: string | undefined;
  let turnNo = 0;
  let lastMessage: string | undefined;
  const started = new Set<string>();
  const turnId = () => `codex-turn-${turnNo}`;

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
        message: `codex ${String(ev.type)} event: ${what}`,
        raw: line,
      },
    ];

    const call = (item: Obj, id: string): VendorItem | null => {
      switch (item.type) {
        case 'command_execution':
          return typeof item.command === 'string'
            ? { kind: 'tool_call', id, name: 'shell', input: { command: item.command } }
            : null;
        case 'file_change':
          return { kind: 'tool_call', id, name: 'apply_patch', input: { changes: item.changes ?? [] } };
        case 'mcp_tool_call':
          return {
            kind: 'tool_call',
            id,
            name: `mcp:${String(item.server ?? '?')}.${String(item.tool ?? '?')}`,
            input: item.arguments ?? null,
          };
        case 'web_search':
          return { kind: 'tool_call', id, name: 'web_search', input: { query: item.query ?? null } };
        default:
          return null;
      }
    };

    const resultOf = (item: Obj, id: string): VendorItem | null => {
      switch (item.type) {
        case 'command_execution':
          return {
            kind: 'tool_result',
            id,
            text: typeof item.aggregated_output === 'string' ? item.aggregated_output : '',
            is_error:
              item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0),
          };
        case 'file_change': {
          const changes = Array.isArray(item.changes) ? item.changes : [];
          const text = changes
            .map((c) => (isObj(c) ? `${String(c.kind ?? 'change')} ${String(c.path ?? '?')}` : ''))
            .filter(Boolean)
            .join('\n');
          return { kind: 'tool_result', id, text, is_error: item.status === 'failed' };
        }
        case 'mcp_tool_call':
        case 'web_search': {
          const err = isObj(item.error) ? String(item.error.message ?? 'error') : undefined;
          let text = err ?? '';
          if (!err && item.result !== undefined) {
            try {
              text = JSON.stringify(item.result);
            } catch {
              text = '';
            }
          }
          return { kind: 'tool_result', id, text, is_error: err !== undefined || item.status === 'failed' };
        }
        default:
          return null;
      }
    };

    switch (ev.type) {
      case 'thread.started': {
        if (typeof ev.thread_id !== 'string' || !ev.thread_id) return bad('without thread_id');
        threadId = ev.thread_id;
        return [{ kind: 'session', session_id: ev.thread_id }];
      }
      case 'turn.started': {
        turnNo++;
        return [];
      }
      case 'item.started':
      case 'item.completed': {
        const item = ev.item;
        if (!isObj(item) || typeof item.type !== 'string') return bad('item is not an object with a type');
        if (typeof item.id !== 'string' || !item.id) return bad('item without id');
        const id = item.id;
        if (item.type === 'agent_message') {
          if (ev.type !== 'item.completed') return [];
          const text = typeof item.text === 'string' ? item.text : '';
          lastMessage = text;
          return [{ kind: 'turn', text, message_id: turnId() }];
        }
        const out: VendorItem[] = [];
        if (!started.has(id)) {
          const c = call(item, id);
          if (c === null) {
            if (item.type === 'command_execution') return bad('command_execution without command');
            return [];
          }
          started.add(id);
          out.push(c);
        }
        if (ev.type === 'item.completed') {
          const r = resultOf(item, id);
          if (r) out.push(r);
        }
        return out;
      }
      case 'turn.completed': {
        const usage = codexUsage(ev.usage);
        const report = lastMessage === undefined ? undefined : parseReport(lastMessage);
        return [
          { kind: 'turn', text: '', message_id: turnId(), ...(usage ? { usage } : {}) },
          {
            kind: 'result',
            ok: true,
            subtype: 'success',
            ...(usage ? { usage } : {}),
            ...(threadId ? { session_id: threadId } : {}),
            ...(lastMessage !== undefined && report === undefined ? { summary: lastMessage } : {}),
            report,
          },
        ];
      }
      case 'turn.failed': {
        const msg =
          isObj(ev.error) && typeof ev.error.message === 'string' ? ev.error.message : 'turn failed';
        return [
          {
            kind: 'result',
            ok: false,
            subtype: 'turn_failed',
            ...(threadId ? { session_id: threadId } : {}),
            summary: msg,
          },
        ];
      }
      default:
        return [];
    }
  };
}
