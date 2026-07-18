import { describe, expect, it } from 'vitest';
import { isTextFocused } from './inspector-node-kind.js';

describe('inspector-node-kind / isTextFocused', () => {
  it('is true for a literal text-kind node (forward-compatible with a future buildTree)', () => {
    expect(isTextFocused({ kind: 'text', tag: null })).toBe(true);
  });

  it('is true for a text-like HTML tag surfaced as a generic element (h1/p/span/a)', () => {
    for (const tag of ['h1', 'h2', 'p', 'span', 'a', 'label', 'li']) {
      expect(isTextFocused({ kind: 'element', tag })).toBe(true);
    }
  });

  it('is false for a generic container element (div/section/button)', () => {
    for (const tag of ['div', 'section', 'button', 'nav', 'form']) {
      expect(isTextFocused({ kind: 'element', tag })).toBe(false);
    }
  });

  it('deliberately excludes button (routinely a flex container — stays on the full element stack)', () => {
    expect(isTextFocused({ kind: 'element', tag: 'button' })).toBe(false);
  });

  it('is false for a fragment and a component-instance', () => {
    expect(isTextFocused({ kind: 'fragment', tag: null })).toBe(false);
    expect(isTextFocused({ kind: 'component-instance', tag: 'Badge' })).toBe(false);
  });
});
