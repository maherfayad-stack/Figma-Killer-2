// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { computeParentLayout } from './parent-layout.js';

function fixture(inner: string): void {
  document.body.innerHTML = inner;
}

describe('computeParentLayout', () => {
  it('rejects an unknown uid', () => {
    fixture(`<div data-uid="a"></div>`);
    expect(computeParentLayout('nope')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('rejects a dynamic-locked node (defense in depth — studio should never even ask)', () => {
    fixture(`<div style="display:flex"><span data-uid="a" data-dynamic="true"></span></div>`);
    expect(computeParentLayout('a')).toEqual({ ok: false, reason: 'dynamic-locked' });
  });

  it('reports no-parent for a node with no real DOM parent element (detached)', () => {
    const el = document.createElement('div');
    el.setAttribute('data-uid', 'floating');
    const fakeDoc = {
      querySelectorAll: (sel: string) => (sel === '[data-uid]' ? [el] : []),
    } as unknown as Document;
    expect(computeParentLayout('floating', fakeDoc)).toEqual({ ok: false, reason: 'no-parent' });
  });

  it('detects a flex parent, row axis, and reports ordered sibling uids incl. self', () => {
    fixture(`
      <section style="display:flex;flex-direction:row" data-uid="parent">
        <h1 data-uid="a">A</h1>
        <p data-uid="b">B</p>
        <button data-uid="c">C</button>
      </section>
    `);
    const result = computeParentLayout('b');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.info.mode).toBe('flex');
    expect(result.info.axis).toBe('row');
    expect(result.info.parentUid).toBe('parent');
    expect(result.info.parentPositioned).toBe(false);
    expect(result.info.index).toBe(1);
    expect(result.info.siblingUids).toEqual(['a', 'b', 'c']);
  });

  it('detects flex-direction:column axis', () => {
    fixture(`
      <section style="display:flex;flex-direction:column" data-uid="parent">
        <h1 data-uid="a">A</h1>
        <p data-uid="b">B</p>
      </section>
    `);
    const result = computeParentLayout('a');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.info.mode).toBe('flex');
    expect(result.info.axis).toBe('column');
  });

  it('detects a grid parent via computed display + grid-auto-flow', () => {
    fixture(`
      <div style="display:grid;grid-auto-flow:column" data-uid="parent">
        <span data-uid="a">A</span>
        <span data-uid="b">B</span>
      </div>
    `);
    const result = computeParentLayout('a');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.info.mode).toBe('grid');
    expect(result.info.axis).toBe('column');
  });

  it('detects inline-flex the same as flex (still the reorder branch)', () => {
    fixture(`
      <div style="display:inline-flex" data-uid="parent">
        <span data-uid="a">A</span>
      </div>
    `);
    const result = computeParentLayout('a');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.info.mode).toBe('flex');
  });

  it('reports mode "none" for a plain (non-flex/grid) parent — the FREE-DRAG branch', () => {
    fixture(`
      <div data-uid="parent">
        <span data-uid="a">A</span>
      </div>
    `);
    const result = computeParentLayout('a');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.info.mode).toBe('none');
  });

  it('reports parentPositioned:true when the parent already has a non-static position', () => {
    fixture(`
      <div style="position:relative" data-uid="parent">
        <span data-uid="a">A</span>
      </div>
    `);
    const result = computeParentLayout('a');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.info.parentPositioned).toBe(true);
  });

  it('reports parentUid:null when the real DOM parent has no data-uid (component-instance/fragment boundary)', () => {
    fixture(`
      <div id="untagged-parent" style="display:flex">
        <span data-uid="a">A</span>
      </div>
    `);
    const result = computeParentLayout('a');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.info.parentUid).toBeNull();
    expect(result.info.mode).toBe('flex'); // layout mode is still correctly read from the real DOM parent
  });

  it('only counts DIRECT children as siblings, not deep descendants', () => {
    fixture(`
      <section style="display:flex" data-uid="parent">
        <div data-uid="a"><span data-uid="a.0">nested</span></div>
        <p data-uid="b">B</p>
      </section>
    `);
    const result = computeParentLayout('a');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.info.siblingUids).toEqual(['a', 'b']);
  });
});
