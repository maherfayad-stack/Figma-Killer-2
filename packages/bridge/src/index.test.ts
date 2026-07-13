import { describe, expect, it } from 'vitest';
import { BRIDGE_PACKAGE_PHASE, notImplementedYet } from './index.js';

describe('@ccs/bridge (P0 stub)', () => {
  it('declares its owning phase', () => {
    expect(BRIDGE_PACKAGE_PHASE).toBe('P2');
  });

  it('throws a clear error for not-yet-implemented P2 features', () => {
    expect(() => notImplementedYet('hit-test')).toThrow(/P2 scope/);
  });
});
