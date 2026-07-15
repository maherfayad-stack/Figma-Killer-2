import { describe, expect, it } from 'vitest';
import { cssVarForFlatToken, cssVarForTypographyField } from './css-var.js';

/**
 * AUDIT-7 blocker close-out — sink-side defense-in-depth. The daemon
 * boundary (`packages/sync-daemon/src/token-crud.ts`'s `validateTokenKey`)
 * is the authoritative gate that should reject an unsafe key long before
 * it reaches here, but this module is a standalone part of the FROZEN
 * `@ccs/tokens` engine API (ADR-0022) and must not assume every caller
 * validated its input — a key containing CSS-breaking characters must
 * still produce only a safe custom-property name.
 */
describe('cssVarForFlatToken — sink-side sanitization', () => {
  it('produces normal output for legitimate keys (no false-positive regression)', () => {
    expect(cssVarForFlatToken('color', 'aqua100')).toBe('--color-aqua-100');
    expect(cssVarForFlatToken('spacing', 'base')).toBe('--space');
    expect(cssVarForFlatToken('spacing', '2xl')).toBe('--space-2xl');
    expect(cssVarForFlatToken('rounded', 'lg')).toBe('--rounded-lg');
  });

  it('strips CSS-breaking characters out of an unsafe key rather than splicing them into the var name', () => {
    const cssVar = cssVarForFlatToken('color', 'x: red; } body { display:none } /* pwned');
    expect(cssVar).not.toContain(';');
    expect(cssVar).not.toContain('{');
    expect(cssVar).not.toContain('}');
    expect(cssVar).not.toContain('/*');
    expect(cssVar).not.toContain(' ');
    expect(cssVar).toMatch(/^--color-[A-Za-z0-9_-]+$/);
  });

  it('strips a key containing a raw newline', () => {
    const cssVar = cssVarForFlatToken('color', 'a\n} body { display:none } {');
    expect(cssVar).toMatch(/^--color-[A-Za-z0-9_-]+$/);
  });
});

describe('cssVarForTypographyField — sink-side sanitization', () => {
  it('produces normal output for legitimate scale/field names', () => {
    expect(cssVarForTypographyField('display', 'fontSize')).toBe('--type-display-size');
  });

  it('strips CSS-breaking characters out of an unsafe scale name', () => {
    const cssVar = cssVarForTypographyField('x: red; } body { display:none } /* pwned', 'fontSize');
    expect(cssVar).toMatch(/^--type-[A-Za-z0-9_-]+-size$/);
  });
});
