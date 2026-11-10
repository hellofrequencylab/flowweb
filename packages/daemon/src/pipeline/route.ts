// Which adapter a run uses. --adapter or $FW_VENDOR wins. Otherwise, when a routing table exists
// ($FW_HOME/config/routing.json, then <repo>/config/routing.json), the router picks the first
// preferred adapter that declares schema output (every work order names a result schema) and whose
// required credential resolves. A fallback is returned so run.queued can record it. With no table,
// the adapters package default is used, as before routing existed.
import {
  type AdapterName,
  adapterCredentials,
  DEFAULT_ADAPTER,
  findRoutingTable,
  isAdapterName,
  loadRoutingTable,
  type Route,
  routeAdapter,
} from '@fw/adapters';
import { resolveCredentialHandle } from '../creds/index.ts';

export interface AdapterChoice {
  name: string;
  route_fallback: Route['fallback'];
}

export interface ChooseOptions {
  adapter?: string;
  env: Record<string, string | undefined>;
  fwHome: string;
  repoDir: string;
  keychain?: boolean;
}

/** The reason an adapter cannot run now: a required credential of its lane that does not resolve. */
export function credentialGap(name: AdapterName, o: ChooseOptions): string | undefined {
  for (const c of adapterCredentials(name, o.env)) {
    if (!c.required) continue;
    try {
      resolveCredentialHandle(c.handle, {
        home: o.fwHome,
        ...(o.keychain !== undefined ? { keychain: o.keychain } : {}),
      });
    } catch (e) {
      return `${name}: required credential ${c.handle} is not available (${e instanceof Error ? e.message : String(e)})`;
    }
  }
  return undefined;
}

export function chooseAdapter(o: ChooseOptions): AdapterChoice {
  const named = o.adapter ?? o.env.FW_VENDOR;
  if (named !== undefined) return { name: named, route_fallback: null };
  const path = findRoutingTable(o.repoDir, o.fwHome);
  if (!path) return { name: DEFAULT_ADAPTER, route_fallback: null };
  const route = routeAdapter(
    loadRoutingTable(path),
    { needs: ['supports_schema'] },
    { unavailable: (n) => (isAdapterName(n) ? credentialGap(n, o) : `${n} is not an adapter`) },
  );
  if (!route.adapter)
    throw Object.assign(
      new Error(
        `no adapter in ${path} can run this work order: ${route.rejected.map((r) => r.reason).join('; ')}`,
      ),
      { code: 'UNAVAILABLE', details: { rejected: route.rejected } },
    );
  return { name: route.adapter, route_fallback: route.fallback };
}
