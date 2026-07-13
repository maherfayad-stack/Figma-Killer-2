import { describe, expect, it } from 'vitest';
import { AST_ENGINE_PACKAGE_PHASE, notImplementedYet } from './index.js';

describe('@ccs/ast-engine (P0 stub)', () => {
  it('declares its owning phase', () => {
    expect(AST_ENGINE_PACKAGE_PHASE).toBe('P3');
  });

  it('throws a clear error for not-yet-implemented P3 features', () => {
    expect(() => notImplementedYet('applyOp')).toThrow(/P3 scope/);
  });
});
