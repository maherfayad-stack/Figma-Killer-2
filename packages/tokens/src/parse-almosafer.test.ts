import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAlmosaferTokensJs } from './parse-almosafer.js';
import { findToken, tokensByGroup } from './types.js';

const REAL_TOKENS_JS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'design-system',
  'src',
  'tokens',
  'tokens.js',
);

describe('parseAlmosaferTokensJs — real design-system/src/tokens/tokens.js', () => {
  const sourceText = readFileSync(REAL_TOKENS_JS_PATH, 'utf8');
  const model = parseAlmosaferTokensJs(sourceText);

  it('parses color tokens with both light and dark values', () => {
    const aqua100 = findToken(model, 'color', 'aqua100');
    expect(aqua100).toBeDefined();
    expect(aqua100?.value.light).toBe('#0C9AB0');
    expect(aqua100?.value.dark).toBe('#07ACC5');
    expect(aqua100?.cssVar).toBe('--color-aqua-100');
  });

  it('falls back to the light value for brand colors with no dark override', () => {
    const almosafer = findToken(model, 'color', 'almosafer');
    expect(almosafer?.value.light).toBe('#003143');
    expect(almosafer?.value.dark).toBe('#003143'); // no colorsDark.almosafer — static
  });

  it('falls back to the dark-only value when a key only exists in colorsDark', () => {
    // colorsDark has `blackStatic`, `colors` does not.
    const blackStatic = findToken(model, 'color', 'blackStatic');
    expect(blackStatic?.value.light).toBe('#1C1C1C');
    expect(blackStatic?.value.dark).toBe('#1C1C1C');
  });

  it('parses spacing with the "base" -> bare CSS var special case', () => {
    const base = findToken(model, 'spacing', 'base');
    expect(base?.value.light).toBe(16);
    expect(base?.cssVar).toBe('--space');
    const md = findToken(model, 'spacing', 'md');
    expect(md?.cssVar).toBe('--space-md');
    expect(md?.value.light).toBe(12);
    const cardGap = findToken(model, 'spacing', 'cardGap');
    expect(cardGap?.cssVar).toBe('--space-card-gap');
  });

  it('parses digit-leading spacing keys that must be quoted in source (2xs/2xl/3xl/4xl)', () => {
    // `design-system/src/tokens/tokens.js`'s `spacing` export writes these
    // as `'2xs': 2` etc. (a bare `2xs` identifier is invalid JS) — ts-morph's
    // `PropertyAssignment.getName()` returns the RAW quoted text ("'2xl'")
    // for a string-literal-named key, not the logical value ("2xl"); a
    // naive reader corrupts the token name (and therefore its cssVar) into
    // something containing literal quote characters. Regression coverage
    // for `property-name.ts`'s `logicalPropertyName`/`getPropertyByLogicalName`.
    for (const key of ['2xs', '2xl', '3xl', '4xl']) {
      const token = findToken(model, 'spacing', key);
      expect(token, `expected a spacing token named "${key}"`).toBeDefined();
      expect(token?.name).toBe(key);
      expect(token?.cssVar).toBe(`--space-${key}`);
      expect(token?.cssVar).not.toContain("'");
      expect(typeof token?.value.light).toBe('number');
    }
  });

  it('parses rounded with the "base" -> bare CSS var special case', () => {
    const base = findToken(model, 'rounded', 'base');
    expect(base?.value.light).toBe('12px');
    expect(base?.cssVar).toBe('--rounded');
  });

  it('parses elevation shadows', () => {
    const floating = findToken(model, 'elevation', 'floating');
    expect(floating?.value.light).toBe('0px -4px 16px rgba(0, 0, 0, 0.08)');
    expect(floating?.cssVar).toBe('--elevation-floating');
  });

  it('parses nested typography scale.field tokens', () => {
    const size = findToken(model, 'typography', 'display.fontSize');
    expect(size?.value.light).toBe('34px');
    expect(size?.cssVar).toBe('--type-display-size');
    const weight = findToken(model, 'typography', 'display.fontWeight');
    expect(weight?.value.light).toBe(600);
    expect(weight?.type).toBe('fontWeight');
    const ls = findToken(model, 'typography', 'headline.letterSpacing');
    expect(ls?.value.light).toBe('-0.6px'); // negative dimension round-trips
  });

  it('produces a non-trivial, non-empty token set across every group', () => {
    for (const group of ['color', 'spacing', 'rounded', 'elevation', 'typography'] as const) {
      expect(tokensByGroup(model, group).length).toBeGreaterThan(0);
    }
    expect(model.themes).toEqual(['light', 'dark']);
  });
});

describe('parseAlmosaferTokensJs — Arabic/RTL fixture (playbook §5.9)', () => {
  const ARABIC_FIXTURE = `
export const colors = {
  brandLabel: 'علامة تجارية',
  metal: '#1C1C1C',
}
export const colorsDark = {
  metal: '#F8F9F9',
}
export const spacing = { base: 16, md: 12 }
export const rounded = { base: '12px' }
export const elevation = { floating: '0px -4px 16px rgba(0, 0, 0, 0.08)' }
export const typography = {
  display: {
    fontFamily: "'Noto Sans Arabic', system-ui, sans-serif",
    fontSize: '34px',
    fontWeight: 600,
    lineHeight: '52px',
    letterSpacing: '-1px',
  },
}
`;

  it('round-trips an Arabic token value byte-exact', () => {
    const model = parseAlmosaferTokensJs(ARABIC_FIXTURE);
    const brandLabel = findToken(model, 'color', 'brandLabel');
    expect(brandLabel?.value.light).toBe('علامة تجارية');
    expect(brandLabel?.value.dark).toBe('علامة تجارية'); // no dark override — static fallback
  });

  it('round-trips an Arabic font-family value in a nested typography token', () => {
    const model = parseAlmosaferTokensJs(ARABIC_FIXTURE);
    const family = findToken(model, 'typography', 'display.fontFamily');
    expect(family?.value.light).toContain('Noto Sans Arabic');
  });
});
