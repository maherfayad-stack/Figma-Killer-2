import { describe, expect, it } from 'vitest';
import * as pkg from './index.js';

describe('@ccs/bridge public API surface', () => {
  it('exports the bridge installer', () => {
    expect(typeof pkg.installBridge).toBe('function');
  });

  it('exports the hit-test / rects / highlight primitives', () => {
    expect(typeof pkg.performHitTest).toBe('function');
    expect(typeof pkg.buildBreadcrumb).toBe('function');
    expect(typeof pkg.reportRects).toBe('function');
    expect(typeof pkg.createRectsSubscription).toBe('function');
    expect(typeof pkg.setHover).toBe('function');
    expect(typeof pkg.setSelection).toBe('function');
  });

  it('exports the frozen (ADR-0016) protocol schemas', () => {
    expect(pkg.StudioToBridgeMessageSchema).toBeDefined();
    expect(pkg.BridgeToStudioMessageSchema).toBeDefined();
  });

  it('exports the FP-4a text-edit controller', () => {
    expect(typeof pkg.createTextEditController).toBe('function');
  });
});
