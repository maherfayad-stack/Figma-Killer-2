import { describe, expect, it } from 'vitest';
import { colors, colorsDark, tokenSets, themes } from './tokens.js';

describe('design-system-template tokens', () => {
  it('groups the core token categories under one "core" set', () => {
    expect(Object.keys(tokenSets)).toEqual(['core']);
    expect(tokenSets.core.colors).toBe(colors);
  });

  it('exposes light and dark themes with matching key sets', () => {
    expect(Object.keys(themes)).toEqual(['light', 'dark']);
    expect(Object.keys(themes.light).sort()).toEqual(Object.keys(themes.dark).sort());
  });

  it('every light color has a corresponding dark value', () => {
    for (const key of Object.keys(colors) as Array<keyof typeof colors>) {
      expect(colorsDark[key]).toBeDefined();
    }
  });
});
