// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { computeComputedStyle } from './computed-style.js';

function fixture(inner: string): void {
  document.body.innerHTML = inner;
}

describe('computeComputedStyle', () => {
  it('rejects an unknown uid', () => {
    fixture(`<div data-uid="a"></div>`);
    expect(computeComputedStyle('nope')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('reports real, curated computed CSS values for a text node (font-size/color/display)', () => {
    fixture(`<h1 data-uid="hero-title" style="display:block;font-size:32px;color:rgb(255, 0, 0);font-weight:700">Hero</h1>`);
    const result = computeComputedStyle('hero-title');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const byProp = Object.fromEntries(result.info.rows.map((r) => [r.prop, r.value]));
    expect(byProp['display']).toBe('block');
    expect(byProp['font-size']).toBe('32px');
    expect(byProp['color']).toBe('rgb(255, 0, 0)');
    expect(byProp['font-weight']).toBe('700');
  });

  it('groups rows by Penpot-style attribute section (layout/geometry/typography/color)', () => {
    fixture(
      `<div data-uid="box" style="display:flex;flex-direction:column;width:100px;height:50px;color:rgb(0,0,0)"></div>`,
    );
    const result = computeComputedStyle('box');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const groupOf = (prop: string) => result.info.rows.find((r) => r.prop === prop)?.group;
    expect(groupOf('display')).toBe('layout');
    expect(groupOf('flex-direction')).toBe('layout');
    expect(groupOf('width')).toBe('geometry');
    expect(groupOf('height')).toBe('geometry');
    expect(groupOf('color')).toBe('color');
  });

  it('reports computed style even for a dynamic-locked node (read-only — no editable-surface refusal here)', () => {
    fixture(`<span data-uid="dyn" data-dynamic="true" style="display:inline;color:rgb(1,2,3)"></span>`);
    const result = computeComputedStyle('dyn');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.info.rows.some((r) => r.prop === 'color' && r.value === 'rgb(1, 2, 3)')).toBe(true);
  });

  it('is a CURATED set, not the full CSSStyleDeclaration dump', () => {
    fixture(`<div data-uid="box" style="display:block"></div>`);
    const result = computeComputedStyle('box');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // Well under the ~300 raw CSSStyleDeclaration entries a real browser
    // would report for this element.
    expect(result.info.rows.length).toBeLessThan(30);
  });
});
