// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildBreadcrumb, performHitTest } from './hit-test.js';

describe('buildBreadcrumb', () => {
  it('orders outermost -> innermost, ending with the target node, falling back to tag name', () => {
    document.body.innerHTML = `
      <div data-uid="u-outer">
        <section data-uid="u-mid" data-component="ds:Card">
          <button data-uid="u-inner" data-component="ds:Button">
            <span id="leaf"></span>
          </button>
        </section>
      </div>
    `;
    const leaf = document.getElementById('leaf')!;
    expect(buildBreadcrumb(leaf.closest('[data-uid]')!)).toEqual([
      { uid: 'u-outer', name: 'div' },
      { uid: 'u-mid', name: 'ds:Card' },
      { uid: 'u-inner', name: 'ds:Button' },
    ]);
  });

  it('is a single-entry breadcrumb when the node has no tagged ancestors', () => {
    document.body.innerHTML = `<div data-uid="only"></div>`;
    const el = document.querySelector('[data-uid="only"]')!;
    expect(buildBreadcrumb(el)).toEqual([{ uid: 'only', name: 'div' }]);
  });
});

describe('performHitTest', () => {
  it('returns null when elementFromPoint finds nothing', () => {
    document.body.innerHTML = '';
    const fakeDoc = { elementFromPoint: () => null } as unknown as Document;
    expect(performHitTest(0, 0, fakeDoc)).toBeNull();
  });

  it('returns null when the hit element has no tagged ancestor at all', () => {
    document.body.innerHTML = `<div id="untagged"></div>`;
    const el = document.getElementById('untagged')!;
    const fakeDoc = { elementFromPoint: () => el } as unknown as Document;
    expect(performHitTest(5, 5, fakeDoc)).toBeNull();
  });
});
