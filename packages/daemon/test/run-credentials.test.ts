// Owner decision 33: a work order may name its credential handles; without them the run gets the
// adapter's fixed handles, as before.
import { ADAPTER_CREDENTIALS } from '@fw/adapters';
import { validate } from '@fw/contracts';
import { describe, expect, test } from 'vitest';
import { runCredentials } from '../src/pipeline/credentials.ts';

describe('run credentials', () => {
  test('without credentials in the work order, the adapter table is used (lane-narrowed)', () => {
    expect(runCredentials({}, 'fake', {})).toEqual([
      { handle: 'crd_fake0001', env: 'FAKE_VENDOR_API_KEY', required: false, scopes: ['vendor.api'] },
    ]);
    expect(runCredentials({ credentials: [] }, 'noop', {})).toEqual([]);
    const claude = runCredentials({}, 'claude', {});
    expect(claude).toHaveLength(1);
    expect(claude[0]).toMatchObject({ handle: ADAPTER_CREDENTIALS.claude[0]?.handle, required: true });
  });

  test("the work order's credentials replace the adapter's, in order", () => {
    const got = runCredentials(
      {
        credentials: [
          { handle: 'crd_team0001', env: 'TEAM_VENDOR_KEY', required: true },
          { handle: 'crd_fake0001', env: 'FAKE_VENDOR_API_KEY', required: true },
        ],
      },
      'fake',
      {},
    );
    expect(got).toEqual([
      { handle: 'crd_team0001', env: 'TEAM_VENDOR_KEY', required: true, scopes: ['vendor.api'] },
      { handle: 'crd_fake0001', env: 'FAKE_VENDOR_API_KEY', required: true, scopes: ['vendor.api'] },
    ]);
  });

  test('work-order.json accepts a well-formed credentials list and refuses a bad handle or env name', () => {
    const errorsFor = (credentials: unknown) => {
      const r = validate('work-order', { credentials });
      return r.ok ? [] : JSON.stringify(r.errors);
    };
    // The rest of the work order is missing here, so look only for errors under /credentials.
    expect(errorsFor([{ handle: 'crd_team0001', env: 'TEAM_KEY', required: false }])).not.toContain(
      '/credentials',
    );
    expect(errorsFor([{ handle: 'team', env: 'TEAM_KEY', required: false }])).toContain(
      '/credentials/0/handle',
    );
    expect(errorsFor([{ handle: 'crd_team0001', env: 'ld_preload', required: false }])).toContain(
      '/credentials/0/env',
    );
    expect(errorsFor([{ handle: 'crd_team0001', env: 'TEAM_KEY' }])).toContain('/credentials/0');
  });
});
