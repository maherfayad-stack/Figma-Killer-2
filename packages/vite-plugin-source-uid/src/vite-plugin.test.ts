import { describe, expect, it } from 'vitest';
import type { Plugin, ResolvedConfig } from 'vite';
import { sourceUidPlugin, isStudioModeEnabled, CCS_STUDIO_ENV_VAR } from './vite-plugin.js';

/** Rollup/Vite plugin hooks may be a plain function or an
 * `{handler, order?}` object depending on the hook and Vite version; this
 * normalizes so tests can call either shape uniformly. Deliberately loosely
 * typed (test-only helper) — the plugin's own source is fully typed. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function callHook(hook: any, ...args: any[]): any {
  if (!hook) return undefined;
  const fn = typeof hook === 'function' ? hook : hook.handler;
  return fn.call(undefined, ...args);
}

function resolveRoot(plugin: Plugin, root: string): void {
  callHook(plugin.configResolved, { root } as ResolvedConfig);
}

describe('isStudioModeEnabled', () => {
  it('is false by default / for unset or falsy env values', () => {
    expect(isStudioModeEnabled({})).toBe(false);
    expect(isStudioModeEnabled({ [CCS_STUDIO_ENV_VAR]: '0' })).toBe(false);
    expect(isStudioModeEnabled({ [CCS_STUDIO_ENV_VAR]: 'false' })).toBe(false);
  });

  it('is true for "1" or "true"', () => {
    expect(isStudioModeEnabled({ [CCS_STUDIO_ENV_VAR]: '1' })).toBe(true);
    expect(isStudioModeEnabled({ [CCS_STUDIO_ENV_VAR]: 'true' })).toBe(true);
  });
});

describe('sourceUidPlugin — studio-mode gate (P0 standalone contract)', () => {
  it('is a total no-op when disabled: transform returns null and leaves code untouched', () => {
    const plugin = sourceUidPlugin({ enabled: false });
    resolveRoot(plugin, '/project');

    const source = `export default function Hero() { return <div>hi</div>; }`;
    const result = callHook(plugin.transform, source, '/project/src/frames/Hero.tsx');

    expect(result).toBeNull();
  });

  it('tags JSX when enabled', () => {
    const plugin = sourceUidPlugin({ enabled: true });
    resolveRoot(plugin, '/project');

    const source = `export default function Hero() { return <div>hi</div>; }`;
    const result = callHook(plugin.transform, source, '/project/src/frames/Hero.tsx') as
      { code: string } | null | undefined;

    expect(result).toBeTruthy();
    expect(result!.code).toContain('data-uid="src/frames/Hero.tsx:d0"');
  });

  it('ignores non-.tsx files even when enabled', () => {
    const plugin = sourceUidPlugin({ enabled: true });
    resolveRoot(plugin, '/project');

    const result = callHook(plugin.transform, 'export const x = 1;', '/project/src/util.ts');
    expect(result).toBeNull();
  });

  it('ignores node_modules even when enabled', () => {
    const plugin = sourceUidPlugin({ enabled: true });
    resolveRoot(plugin, '/project');

    const result = callHook(
      plugin.transform,
      `export default function X() { return <div/>; }`,
      '/project/node_modules/some-dep/Thing.tsx',
    );
    expect(result).toBeNull();
  });

  it('handles Vite HMR query-string ids (foo.tsx?t=123) when enabled', () => {
    const plugin = sourceUidPlugin({ enabled: true });
    resolveRoot(plugin, '/project');

    const result = callHook(
      plugin.transform,
      `export default function Hero() { return <div/>; }`,
      '/project/src/frames/Hero.tsx?t=1690000000000',
    ) as { code: string } | null | undefined;

    expect(result).toBeTruthy();
    expect(result!.code).toContain('data-uid="src/frames/Hero.tsx:d0"');
  });

  it('falls back to isStudioModeEnabled() (env) when `enabled` option is omitted', () => {
    const originalEnv = process.env[CCS_STUDIO_ENV_VAR];
    try {
      delete process.env[CCS_STUDIO_ENV_VAR];
      const disabledPlugin = sourceUidPlugin();
      resolveRoot(disabledPlugin, '/project');
      const disabledResult = callHook(
        disabledPlugin.transform,
        `export default function Hero() { return <div/>; }`,
        '/project/src/frames/Hero.tsx',
      );
      expect(disabledResult).toBeNull();

      process.env[CCS_STUDIO_ENV_VAR] = '1';
      const enabledPlugin = sourceUidPlugin();
      resolveRoot(enabledPlugin, '/project');
      const enabledResult = callHook(
        enabledPlugin.transform,
        `export default function Hero() { return <div/>; }`,
        '/project/src/frames/Hero.tsx',
      ) as { code: string } | null | undefined;
      expect(enabledResult).toBeTruthy();
      expect(enabledResult!.code).toContain('data-uid');
    } finally {
      if (originalEnv === undefined) delete process.env[CCS_STUDIO_ENV_VAR];
      else process.env[CCS_STUDIO_ENV_VAR] = originalEnv;
    }
  });
});
