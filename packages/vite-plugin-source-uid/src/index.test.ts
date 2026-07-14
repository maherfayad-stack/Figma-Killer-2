import { describe, expect, it } from 'vitest';
import * as pkg from './index.js';

describe('@ccs/vite-plugin-source-uid public API surface', () => {
  it('exports the Vite plugin factory and studio-mode helpers', () => {
    expect(typeof pkg.sourceUidPlugin).toBe('function');
    expect(typeof pkg.isStudioModeEnabled).toBe('function');
    expect(pkg.CCS_STUDIO_ENV_VAR).toBe('CCS_STUDIO');
  });

  it('exports the shared astPath derivation used by both the plugin and tests/P3', () => {
    expect(typeof pkg.deriveUidPaths).toBe('function');
    expect(typeof pkg.createUidPathTracker).toBe('function');
  });

  it('exports the lower-level Babel transform for tooling/tests', () => {
    expect(typeof pkg.transformSourceUid).toBe('function');
    expect(typeof pkg.createSourceUidBabelPlugin).toBe('function');
  });

  it('exports the dynamic + component-resolution helpers', () => {
    expect(typeof pkg.isDynamicJsxNode).toBe('function');
    expect(typeof pkg.resolveComponentTag).toBe('function');
  });
});
