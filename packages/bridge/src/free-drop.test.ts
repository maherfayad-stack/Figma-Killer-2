// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { resolveFreeDrop } from './free-drop.js';

function fixture(inner: string): void {
  document.body.innerHTML = inner;
}

/** jsdom never lays anything out (`getBoundingClientRect` is always
 * all-zero) — stub it per-element like the rest of this package's tests
 * that need real numbers (see `bridge-geometry.test.ts`'s analog in
 * `@ccs/canvas` for the same pattern). */
function stubRect(el: Element, rect: { x: number; y: number; width: number; height: number }): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    ...rect,
    top: rect.y,
    left: rect.x,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
    toJSON: () => ({}),
  } as DOMRect);
}

describe('resolveFreeDrop', () => {
  it('rejects an unknown uid', () => {
    fixture(`<div data-uid="a"></div>`);
    expect(resolveFreeDrop('nope', 0, 0)).toEqual({ ok: false, reason: 'not-found' });
  });

  it('rejects a dynamic-locked node', () => {
    fixture(`<div><span data-uid="a" data-dynamic="true"></span></div>`);
    expect(resolveFreeDrop('a', 10, 10)).toEqual({ ok: false, reason: 'dynamic-locked' });
  });

  it('reports no-parent for a detached node', () => {
    const el = document.createElement('div');
    el.setAttribute('data-uid', 'floating');
    const fakeDoc = {
      querySelectorAll: (sel: string) => (sel === '[data-uid]' ? [el] : []),
    } as unknown as Document;
    expect(resolveFreeDrop('floating', 0, 0, fakeDoc)).toEqual({ ok: false, reason: 'no-parent' });
  });

  it('LTR: computes start/top as plain left/top distance from the parent, adds absolute + relative-parent when parent is static', () => {
    fixture(`<div data-uid="parent"><span data-uid="a">A</span></div>`);
    const parent = document.querySelector('[data-uid="parent"]')!;
    const el = document.querySelector('[data-uid="a"]')!;
    stubRect(parent, { x: 100, y: 50, width: 400, height: 300 });
    stubRect(el, { x: 100, y: 50, width: 80, height: 20 });

    const result = resolveFreeDrop('a', 220, 130);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.info.addClasses).toEqual(['absolute', 'start-[120px]', 'top-[80px]']);
    expect(result.info.removeClasses).toEqual([]);
    expect(result.info.parentUid).toBe('parent');
    expect(result.info.parentAddClasses).toEqual(['relative']);
  });

  it('does not add relative to the parent when it is already positioned', () => {
    fixture(`<div data-uid="parent" style="position:relative"><span data-uid="a">A</span></div>`);
    const parent = document.querySelector('[data-uid="parent"]')!;
    const el = document.querySelector('[data-uid="a"]')!;
    stubRect(parent, { x: 0, y: 0, width: 400, height: 300 });
    stubRect(el, { x: 0, y: 0, width: 80, height: 20 });

    const result = resolveFreeDrop('a', 10, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.info.parentAddClasses).toEqual([]);
  });

  it('RTL: resolves start-[] as distance from the parent\'s RIGHT edge, not left', () => {
    fixture(
      `<div data-uid="parent" dir="rtl" style="direction:rtl"><span data-uid="a" style="direction:rtl">A</span></div>`,
    );
    const parent = document.querySelector('[data-uid="parent"]')!;
    const el = document.querySelector('[data-uid="a"]')!;
    stubRect(parent, { x: 0, y: 0, width: 400, height: 300 });
    // Drop target: element's top-left at (300, 40), width 80 -> right edge at 380,
    // 20px from the parent's right edge (400) -> start-[20px] under RTL.
    stubRect(el, { x: 300, y: 40, width: 80, height: 20 });

    const result = resolveFreeDrop('a', 300, 40);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.info.addClasses).toEqual(['absolute', 'start-[20px]', 'top-[40px]']);
  });

  it('re-drag: removes previously-written managed position classes, keeps unrelated classes untouched', () => {
    fixture(
      `<div data-uid="parent"><span data-uid="a" class="text-lg absolute start-[10px] top-[5px] font-bold">A</span></div>`,
    );
    const parent = document.querySelector('[data-uid="parent"]')!;
    const el = document.querySelector('[data-uid="a"]')!;
    stubRect(parent, { x: 0, y: 0, width: 400, height: 300 });
    stubRect(el, { x: 10, y: 5, width: 80, height: 20 });

    const result = resolveFreeDrop('a', 60, 90);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.info.removeClasses.sort()).toEqual(['absolute', 'start-[10px]', 'top-[5px]'].sort());
    expect(result.info.addClasses).toEqual(['absolute', 'start-[60px]', 'top-[90px]']);
    // unrelated classes (text-lg, font-bold) are never reported for removal
    expect(result.info.removeClasses).not.toContain('text-lg');
    expect(result.info.removeClasses).not.toContain('font-bold');
  });

  it('clamps negative offsets to 0 (dropping above/left of the parent origin)', () => {
    fixture(`<div data-uid="parent"><span data-uid="a">A</span></div>`);
    const parent = document.querySelector('[data-uid="parent"]')!;
    const el = document.querySelector('[data-uid="a"]')!;
    stubRect(parent, { x: 100, y: 100, width: 400, height: 300 });
    stubRect(el, { x: 100, y: 100, width: 80, height: 20 });

    const result = resolveFreeDrop('a', -50, -50);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.info.addClasses).toEqual(['absolute', 'start-[0px]', 'top-[0px]']);
  });
});
