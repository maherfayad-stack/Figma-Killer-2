import { describe, expect, it } from 'vitest';
import { CANVAS_PACKAGE_PHASE, notImplementedYet } from './index.js';

// Placeholder test — this package's real surface (tldraw FrameShape,
// overlay) lands in P1 (playbook §4/P1). This just proves the package
// boundary boots and is wired into `pnpm test`.
describe('@ccs/canvas (P0 stub)', () => {
  it('declares its owning phase', () => {
    expect(CANVAS_PACKAGE_PHASE).toBe('P1');
  });

  it('throws a clear error for not-yet-implemented P1 features', () => {
    expect(() => notImplementedYet('FrameShape')).toThrow(/P1 scope/);
  });
});
