import { describe, expect, it } from 'vitest';
import { SYNC_DAEMON_PACKAGE_PHASE, notImplementedYet } from './index.js';

describe('@ccs/sync-daemon (P0 stub)', () => {
  it('declares its owning phase', () => {
    expect(SYNC_DAEMON_PACKAGE_PHASE).toBe('P1');
  });

  it('throws a clear error for not-yet-implemented P1 features', () => {
    expect(() => notImplementedYet('vite orchestration')).toThrow(/P1 scope/);
  });
});
