import { describe, expect, it } from 'vitest';
import { UI_PACKAGE_PHASE, notImplementedYet } from './index.js';

describe('@ccs/ui (P0 stub)', () => {
  it('declares its owning phase', () => {
    expect(UI_PACKAGE_PHASE).toBe('P5');
  });

  it('throws a clear error for not-yet-implemented P5 features', () => {
    expect(() => notImplementedYet('WorkspaceShell')).toThrow(/P5 scope/);
  });
});
