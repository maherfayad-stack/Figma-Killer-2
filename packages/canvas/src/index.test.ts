import { describe, expect, it } from 'vitest';
import { CANVAS_PACKAGE_PHASE, StudioCanvas, buildFrameSource, isValidFrameName } from './index.js';

// Barrel-export smoke test: the important P1 guarantee is that
// `@ccs/canvas`'s public surface is exactly the tldraw-independent shapes
// documented in index.ts (playbook §5.4) — this doesn't re-verify every
// unit test elsewhere in the package, just that the barrel wires up and
// stays free of a tldraw type/class leaking through by accident (which
// would show up as a type error at the `import type { ... } from 'tldraw'`
// re-export site, not here — this is a runtime sanity check).
describe('@ccs/canvas public API', () => {
  it('declares its owning phase', () => {
    expect(CANVAS_PACKAGE_PHASE).toBe('P1');
  });

  it('exports the StudioCanvas component', () => {
    expect(typeof StudioCanvas).toBe('function');
  });

  it('re-exports the new-frame pure builders', () => {
    expect(isValidFrameName('Hero')).toBe(true);
    expect(buildFrameSource('Hero')).toContain('export default function Hero');
  });
});
