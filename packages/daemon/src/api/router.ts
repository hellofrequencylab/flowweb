// A tiny router: method plus a path pattern with `{name}` segments. No dependencies.
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
}

export type Handler = (ctx: RouteContext) => unknown | Promise<unknown>;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

export type Match =
  | { kind: 'found'; handler: Handler; params: Record<string, string> }
  | { kind: 'method_not_allowed'; allow: string[] }
  | { kind: 'not_found' };

function split(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method: method.toUpperCase(), parts: split(pattern), handler });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.add('POST', pattern, handler);
  }

  delete(pattern: string, handler: Handler): this {
    return this.add('DELETE', pattern, handler);
  }

  /** Literal segments win over `{param}` segments, so a fixed path beats a pattern of the same length. */
  match(method: string, pathname: string): Match {
    const segs = split(pathname);
    let best: { route: Route; params: Record<string, string>; score: number } | undefined;
    const allow = new Set<string>();
    for (const route of this.routes) {
      if (route.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let score = 0;
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const p = route.parts[i]!;
        const s = segs[i]!;
        if (p.startsWith('{') && p.endsWith('}')) {
          let v: string;
          try {
            v = decodeURIComponent(s);
          } catch {
            ok = false;
            break;
          }
          params[p.slice(1, -1)] = v;
        } else if (p === s) {
          score++;
        } else {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      allow.add(route.method);
      const methodOk = route.method === method || (method === 'HEAD' && route.method === 'GET');
      if (methodOk && (best === undefined || score > best.score)) best = { route, params, score };
    }
    if (best) return { kind: 'found', handler: best.route.handler, params: best.params };
    if (allow.size > 0) return { kind: 'method_not_allowed', allow: [...allow] };
    return { kind: 'not_found' };
  }
}
