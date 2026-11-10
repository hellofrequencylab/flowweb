// Which credential handles a run resolves (pipeline stage 5). A work order that names its
// credentials (`credentials[] {handle, env, required}`, work-order.json) gets exactly those; one that
// does not gets the adapter's fixed handles from @fw/adapters ADAPTER_CREDENTIALS, narrowed to the
// credential lane the environment selects. Either way the values go only into the vendor process
// environment; the driver still decides which variables it passes on.

import { ADAPTER_CREDENTIALS, type AdapterName, adapterCredentials } from '@fw/adapters';
import type { WorkOrder } from '@fw/contracts';
import type { CredentialRequest } from '../creds/index.ts';

const DEFAULT_SCOPES = ['vendor.api'];

export function runCredentials(
  order: Pick<WorkOrder, 'credentials'>,
  adapter: AdapterName,
  env: Record<string, string | undefined>,
): CredentialRequest[] {
  if (order.credentials?.length) {
    return order.credentials.map((c) => ({
      handle: c.handle,
      env: c.env,
      required: c.required,
      // Scopes are not part of the work order; a handle the adapter table knows keeps its scopes.
      scopes: [
        ...(ADAPTER_CREDENTIALS[adapter].find((k) => k.handle === c.handle)?.scopes ?? DEFAULT_SCOPES),
      ],
    }));
  }
  return adapterCredentials(adapter, env).map((r) => ({
    handle: r.handle,
    env: r.env,
    required: r.required,
    scopes: [...r.scopes],
  }));
}
