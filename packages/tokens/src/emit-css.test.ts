import { describe, expect, it } from 'vitest';
import { emitCss } from './emit-css.js';
import { parseAlmosaferTokensJs } from './parse-almosafer.js';
import type { TokenModel } from './types.js';

const FIXTURE = `
export const colors = { aqua100: '#0C9AB0', metal: '#1C1C1C' }
export const colorsDark = { aqua100: '#07ACC5', metal: '#F8F9F9' }
export const spacing = { base: 16, md: 12 }
export const rounded = { base: '12px', lg: '16px' }
export const elevation = { floating: '0px -4px 16px rgba(0, 0, 0, 0.08)' }
export const typography = {
  display: { fontFamily: "'Open Sans', system-ui", fontSize: '34px', fontWeight: 600, lineHeight: '52px', letterSpacing: '-1px' },
}
`;

describe('emitCss', () => {
  const model = parseAlmosaferTokensJs(FIXTURE);

  it('emits a plain :root block for the light theme', () => {
    const css = emitCss(model, 'light');
    expect(css).toContain(':root {');
    expect(css).toContain('--color-aqua-100: #0C9AB0;');
    expect(css).toContain('--space: 16;');
    expect(css).toContain('--rounded: 12px;');
    expect(css).toContain('--rounded-lg: 16px;');
    expect(css).toContain('--type-display-size: 34px;');
  });

  it('emits a prefers-color-scheme media query + a forced [data-theme=dark] override for dark', () => {
    const css = emitCss(model, 'dark');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain(':root:not([data-theme="light"])');
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain('--color-aqua-100: #07ACC5;');
  });

  it('is dir-agnostic — never emits a [dir=...] selector or branches on direction', () => {
    expect(emitCss(model, 'light')).not.toMatch(/\[dir=/);
    expect(emitCss(model, 'dark')).not.toMatch(/\[dir=/);
  });

  it('emits theme-independent groups (spacing/rounded/elevation/typography) identically in both themes', () => {
    const light = emitCss(model, 'light');
    const dark = emitCss(model, 'dark');
    expect(light).toContain('--space-md: 12;');
    expect(dark).toContain('--space-md: 12;');
  });
});

// ---- AUDIT-7 blocker — sink-side defense-in-depth ------------------------
//
// This emitter is a standalone part of the FROZEN `@ccs/tokens` engine API
// (ADR-0022) and must not assume every `TokenModel` handed to it went
// through the daemon-boundary validation (`packages/sync-daemon/src/
// token-crud.ts`). These tests hand-build a malicious `TokenModel` directly
// (bypassing that boundary entirely) to prove `emitCss` itself refuses to
// produce declaration/rule-breaking output.

function modelWith(token: Partial<TokenModel['tokens'][number]> & { cssVar: string; value: Record<'light' | 'dark', string | number> }): TokenModel {
  return {
    themes: ['light', 'dark'],
    tokens: [
      {
        name: token.name ?? 'malicious',
        group: token.group ?? 'color',
        type: token.type ?? 'color',
        value: token.value,
        cssVar: token.cssVar,
      },
    ],
  };
}

describe('emitCss — sink-side hardening against a malicious TokenModel', () => {
  it('throws rather than emit a value that breaks out of its declaration (semicolon + new rule)', () => {
    const model = modelWith({
      cssVar: '--color-x',
      value: { light: 'red; } body { display:none } /* pwned', dark: '#000' },
    });
    expect(() => emitCss(model, 'light')).toThrow();
  });

  it('throws rather than emit a value containing a comment-open sequence', () => {
    const model = modelWith({ cssVar: '--color-y', value: { light: '#000 /* pwned */', dark: '#000' } });
    expect(() => emitCss(model, 'light')).toThrow();
  });

  it('throws rather than emit a value containing a raw newline', () => {
    const model = modelWith({ cssVar: '--color-z', value: { light: '#000\n} body { display:none } {', dark: '#000' } });
    expect(() => emitCss(model, 'light')).toThrow();
  });

  it('throws rather than emit an unsafe custom-property NAME', () => {
    const model = modelWith({ cssVar: '--color-x: red; } body { display:none } /* pwned', value: { light: '#000', dark: '#000' } });
    expect(() => emitCss(model, 'light')).toThrow();
  });

  it('never produces output containing the injected payload for any malicious field, when it does not throw synchronously in the caller', () => {
    const model = modelWith({
      cssVar: '--color-x',
      value: { light: 'red; } body { display:none } /* pwned', dark: '#000' },
    });
    let css = '';
    try {
      css = emitCss(model, 'light');
    } catch {
      // expected — see the throw-based tests above; if it somehow didn't
      // throw, the assertion below still guards against a leaked payload.
    }
    expect(css).not.toContain('pwned');
    expect(css).not.toMatch(/display:\s*none/);
  });

  it('still emits normally for safe names/values (no false-positive regression)', () => {
    const model = modelWith({ cssVar: '--color-safe', value: { light: '#123456', dark: '#654321' } });
    expect(() => emitCss(model, 'light')).not.toThrow();
    expect(emitCss(model, 'light')).toContain('--color-safe: #123456;');
  });
});
