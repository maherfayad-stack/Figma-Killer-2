// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { setHover, setSelection } from './highlight.js';

describe('setHover / setSelection — minimal in-iframe highlight', () => {
  it('setHover toggles the hover class on exactly one element at a time', () => {
    document.body.innerHTML = `<div data-uid="a"></div><div data-uid="b"></div>`;

    setHover('a');
    expect(document.querySelector('[data-uid="a"]')!.className).toContain('ccs-bridge-hover');

    setHover('b');
    expect(document.querySelector('[data-uid="a"]')!.className).not.toContain('ccs-bridge-hover');
    expect(document.querySelector('[data-uid="b"]')!.className).toContain('ccs-bridge-hover');

    setHover(null);
    expect(document.querySelector('[data-uid="b"]')!.className).not.toContain('ccs-bridge-hover');
  });

  it('setSelection applies the selected class to multiple uids and clears the previous selection', () => {
    document.body.innerHTML = `<div data-uid="a"></div><div data-uid="b"></div><div data-uid="c"></div>`;

    setSelection(['a', 'b']);
    expect(document.querySelector('[data-uid="a"]')!.className).toContain('ccs-bridge-selected');
    expect(document.querySelector('[data-uid="b"]')!.className).toContain('ccs-bridge-selected');
    expect(document.querySelector('[data-uid="c"]')!.className).not.toContain(
      'ccs-bridge-selected',
    );

    setSelection(['c']);
    expect(document.querySelector('[data-uid="a"]')!.className).not.toContain(
      'ccs-bridge-selected',
    );
    expect(document.querySelector('[data-uid="c"]')!.className).toContain('ccs-bridge-selected');
  });

  it('setSelection with an unknown uid is a no-op for that uid (no throw)', () => {
    document.body.innerHTML = `<div data-uid="a"></div>`;
    expect(() => setSelection(['does-not-exist'])).not.toThrow();
  });
});
