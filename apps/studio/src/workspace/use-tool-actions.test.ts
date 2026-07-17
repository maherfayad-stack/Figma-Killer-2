import { describe, expect, it } from 'vitest';
import { nextFrameName } from './use-tool-actions.js';

/**
 * `nextFrameName` is the one pure, dependency-free piece of the FP-3
 * tool-action bridge (`use-tool-actions.ts`) — the rest of the hook is a
 * thin wrapper around `useDaemonConnection`/`useWorkspaceStore` (React
 * context + a global store), which this package has no component-render
 * test harness for (no `@testing-library/react` dependency; every other
 * daemon/store-dependent hook in this directory — `use-node-ops.ts`,
 * `use-component-insert.ts` — is likewise only exercised by the real
 * browser dogfood, not a unit test). See the FP-3 report for how the full
 * bridge was verified end-to-end instead.
 */
describe('nextFrameName', () => {
  it('picks Frame1 when no frames exist yet', () => {
    expect(nextFrameName(new Set())).toBe('Frame1');
  });

  it('skips past every already-used Frame<N>', () => {
    expect(nextFrameName(new Set(['Frame1', 'Frame2']))).toBe('Frame3');
  });

  it('is not confused by gaps — picks the lowest free number, not one past the max', () => {
    expect(nextFrameName(new Set(['Frame1', 'Frame3']))).toBe('Frame2');
  });

  it('ignores unrelated frame names entirely', () => {
    expect(nextFrameName(new Set(['Hero', 'Pricing', 'Testimonials']))).toBe('Frame1');
  });

  it('is stable given the same input (pure function)', () => {
    const names = new Set(['Frame1']);
    expect(nextFrameName(names)).toBe(nextFrameName(names));
  });
});
