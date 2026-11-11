// FW-C-118: the Owner's stored funnel links switch wins over FW_FUNNELS_LIVE and each flow's config.
import { afterEach, expect, test } from 'vitest';
import { funnelsLive, funnelsView, setFunnelsSettingReader } from '../src/flows/live-links.ts';

afterEach(() => {
  setFunnelsSettingReader(null);
});

test('a stored true or false wins; unset keeps env then config', () => {
  expect(funnelsLive({ funnels_live: true }, { FW_FUNNELS_LIVE: 'on' }, false)).toBe(false);
  expect(funnelsLive({ funnels_live: false }, { FW_FUNNELS_LIVE: 'off' }, true)).toBe(true);
  expect(funnelsLive({ funnels_live: true }, { FW_FUNNELS_LIVE: 'off' }, null)).toBe(false);
  expect(funnelsLive({ funnels_live: false }, {}, null)).toBe(false);
  expect(funnelsLive({}, {})).toBe(true);
});

test('the registered reader is every caller default, and its undo only clears itself', () => {
  const undo = setFunnelsSettingReader(() => false);
  expect(funnelsLive({ funnels_live: true }, {})).toBe(false);
  const undoOther = setFunnelsSettingReader(() => true);
  undo();
  expect(funnelsLive({ funnels_live: false }, { FW_FUNNELS_LIVE: 'off' })).toBe(true);
  undoOther();
  expect(funnelsLive({ funnels_live: false }, {})).toBe(false);
});

test('the view names where the answer comes from', () => {
  expect(funnelsView(true, { FW_FUNNELS_LIVE: 'off' })).toEqual({
    live: true,
    source: 'setting',
    setting: true,
    env_off: true,
  });
  expect(funnelsView(null, { FW_FUNNELS_LIVE: 'off' })).toEqual({
    live: false,
    source: 'env',
    setting: null,
    env_off: true,
  });
  expect(funnelsView(null, {})).toEqual({ live: null, source: 'config', setting: null, env_off: false });
});
