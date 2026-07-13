import { describe, expect, it } from 'vitest';
import { TOKENS_PACKAGE_PHASE, notImplementedYet } from './index.js';

describe('@ccs/tokens (P0 stub)', () => {
  it('declares its owning phase', () => {
    expect(TOKENS_PACKAGE_PHASE).toBe('P4');
  });

  it('throws a clear error for not-yet-implemented P4 features', () => {
    expect(() => notImplementedYet('DTCG parse')).toThrow(/P4 scope/);
  });
});
