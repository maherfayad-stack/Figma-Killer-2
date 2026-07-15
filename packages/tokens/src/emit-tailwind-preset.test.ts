import { describe, expect, it } from 'vitest';
import { emitTailwindPreset, serializePresetModule } from './emit-tailwind-preset.js';
import { parseAlmosaferTokensJs } from './parse-almosafer.js';

const FIXTURE = `
export const colors = { aqua100: '#0C9AB0', aqua200: '#008296' }
export const colorsDark = { aqua100: '#07ACC5', aqua200: '#0394AA' }
export const spacing = { base: 16, md: 12, lg: 24 }
export const rounded = { base: '12px', lg: '16px' }
export const elevation = { floating: '0px -4px 16px rgba(0, 0, 0, 0.08)' }
export const typography = {
  display: { fontFamily: "'Open Sans', system-ui", fontSize: '34px', fontWeight: 600, lineHeight: '52px', letterSpacing: '-1px' },
}
`;

describe('emitTailwindPreset', () => {
  const model = parseAlmosaferTokensJs(FIXTURE);
  const preset = emitTailwindPreset(model);

  it('maps color tokens to var() references keyed by kebab-case name', () => {
    expect(preset.theme.extend.colors['aqua-100']).toBe('var(--color-aqua-100)');
    expect(preset.theme.extend.colors['aqua-200']).toBe('var(--color-aqua-200)');
  });

  it('maps spacing, using DEFAULT for the "base" key', () => {
    expect(preset.theme.extend.spacing['DEFAULT']).toBe('var(--space)');
    expect(preset.theme.extend.spacing['md']).toBe('var(--space-md)');
    expect(preset.theme.extend.spacing['lg']).toBe('var(--space-lg)');
  });

  it('maps rounded to borderRadius and elevation to boxShadow', () => {
    expect(preset.theme.extend.borderRadius['DEFAULT']).toBe('var(--rounded)');
    expect(preset.theme.extend.borderRadius['lg']).toBe('var(--rounded-lg)');
    expect(preset.theme.extend.boxShadow['floating']).toBe('var(--elevation-floating)');
  });

  it('groups typography fields per scale into fontFamily/fontWeight/fontSize', () => {
    expect(preset.theme.extend.fontFamily['display']).toEqual(['var(--type-display-family)']);
    expect(preset.theme.extend.fontWeight['display']).toBe('var(--type-display-weight)');
    expect(preset.theme.extend.fontSize['display']).toEqual([
      'var(--type-display-size)',
      { lineHeight: 'var(--type-display-lh)', letterSpacing: 'var(--type-display-ls)' },
    ]);
  });

  it('serializes to a valid standalone ESM module with a default export', () => {
    const mod = serializePresetModule(preset);
    expect(mod).toContain('export default {');
    expect(mod).toContain('"aqua-100": "var(--color-aqua-100)"');
    expect(mod).not.toMatch(/from\s+['"]@ccs\//); // zero runtime import dep — plain data only
  });
});
