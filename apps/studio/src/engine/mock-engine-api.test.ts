import { describe, expect, it } from 'vitest';
import { createMockEngineApi } from './mock-engine-api.js';

describe('createMockEngineApi (ADR-0022 mock adapter)', () => {
  it('exposes a TokenModel with sets/themes and a working alias resolve', () => {
    const engine = createMockEngineApi();
    expect(engine.tokenModel.sets.length).toBeGreaterThan(0);
    expect(engine.tokenModel.themes.map((t) => t.name)).toEqual(['light', 'dark']);
    expect(engine.tokenModel.resolve('color.primary')?.value).toBe('#0ea5e9');
    expect(engine.tokenModel.resolve('color.does-not-exist')).toBeNull();
  });

  it('listComponents returns {name,category,description}[] (ADR-0022 shape)', () => {
    const engine = createMockEngineApi();
    const components = engine.listComponents();
    expect(components.length).toBeGreaterThan(0);
    for (const c of components) {
      expect(c).toHaveProperty('name');
      expect(c).toHaveProperty('category');
      expect(c).toHaveProperty('description');
    }
    expect(components.map((c) => c.name)).toContain('Button');
  });

  it('getPropSchema returns a required enum prop for Button.variant (ADR-0021 pattern)', () => {
    const engine = createMockEngineApi();
    const schema = engine.getPropSchema('Button');
    expect(schema?.props.variant).toMatchObject({ type: 'enum', required: true, control: 'select' });
    expect(schema?.props.variant?.enum).toContain('primary');
  });

  it('getPropSchema returns null for an unknown component', () => {
    const engine = createMockEngineApi();
    expect(engine.getPropSchema('NoSuchComponent')).toBeNull();
  });

  it('tokensForProperty filters by the group mapped from a CSS property', () => {
    const engine = createMockEngineApi();
    const colorTokens = engine.tokensForProperty('background-color');
    expect(colorTokens.length).toBeGreaterThan(0);
    expect(colorTokens.every((t) => t.name.startsWith('color.'))).toBe(true);

    const radiusTokens = engine.tokensForProperty('border-radius');
    expect(radiusTokens.every((t) => t.name.startsWith('radius.'))).toBe(true);
  });

  it('tokensForProperty returns everything (de-duped by name) for an unmapped CSS property', () => {
    const engine = createMockEngineApi();
    const all = engine.tokensForProperty('unmapped-prop');
    const uniqueNames = new Set(engine.tokenModel.sets.flatMap((s) => s.tokens).map((t) => t.name));
    // De-duped: a theme-override set (`dark-overrides`) shares token NAMES
    // with the base set (same token, different value per theme) — this
    // asserts the unique-name count, not the raw cross-set token count,
    // which would otherwise double-count `color.primary`/`color.surface`
    // and produce a React duplicate-key warning in every <Select> consumer.
    expect(all.length).toBe(uniqueNames.size);
    expect(new Set(all.map((t) => t.name)).size).toBe(all.length);
  });
});
