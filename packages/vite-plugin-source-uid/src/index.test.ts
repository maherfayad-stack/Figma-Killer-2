import { describe, expect, it } from 'vitest';
import { VITE_PLUGIN_SOURCE_UID_PACKAGE_PHASE, notImplementedYet } from './index.js';

describe('@ccs/vite-plugin-source-uid (P0 stub)', () => {
  it('declares its owning phase', () => {
    expect(VITE_PLUGIN_SOURCE_UID_PACKAGE_PHASE).toBe('P2');
  });

  it('throws a clear error for not-yet-implemented P2 features', () => {
    expect(() => notImplementedYet('data-uid injection')).toThrow(/P2 scope/);
  });
});
