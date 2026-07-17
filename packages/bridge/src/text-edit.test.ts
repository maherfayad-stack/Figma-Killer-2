// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createTextEditController } from './text-edit.js';

function fixture(inner: string): void {
  document.body.innerHTML = inner;
}

describe('createTextEditController — enter()', () => {
  it('enters edit mode on a plain text-leaf element: contenteditable set, focused, class applied', () => {
    fixture(`<p data-uid="a">Hello</p>`);
    const onExit = vi.fn();
    const controller = createTextEditController(onExit);

    const result = controller.enter('a');
    expect(result).toEqual({ ok: true, text: 'Hello' });

    const el = document.querySelector('[data-uid="a"]') as HTMLElement;
    expect(el.getAttribute('contenteditable')).toBe('true');
    expect(el.className).toContain('ccs-bridge-editing');
    expect(document.activeElement).toBe(el);
    expect(controller.currentUid()).toBe('a');
  });

  it('rejects an unknown uid', () => {
    fixture(`<p data-uid="a">Hello</p>`);
    const controller = createTextEditController(vi.fn());
    expect(controller.enter('does-not-exist')).toEqual({ ok: false, reason: 'not-found' });
  });

  it('rejects a dynamic-locked node', () => {
    fixture(`<p data-uid="a" data-dynamic="true">Hello</p>`);
    const controller = createTextEditController(vi.fn());
    expect(controller.enter('a')).toEqual({ ok: false, reason: 'dynamic-locked' });
    expect(document.querySelector('[data-uid="a"]')!.getAttribute('contenteditable')).toBeNull();
  });

  it('rejects a component-instance usage site (data-component present)', () => {
    fixture(`<button data-uid="a" data-component="ds:Button">Click</button>`);
    const controller = createTextEditController(vi.fn());
    expect(controller.enter('a')).toEqual({ ok: false, reason: 'component-instance' });
  });

  it('rejects a node with element children (not a text leaf)', () => {
    fixture(`<div data-uid="a"><span data-uid="a.0">nested</span></div>`);
    const controller = createTextEditController(vi.fn());
    expect(controller.enter('a')).toEqual({ ok: false, reason: 'not-a-text-leaf' });
  });

  it('rejects a void element even if somehow tagged', () => {
    fixture(`<img data-uid="a" />`);
    const controller = createTextEditController(vi.fn());
    expect(controller.enter('a')).toEqual({ ok: false, reason: 'void-element' });
  });

  it('rejects a second enter() while one is already in progress', () => {
    fixture(`<p data-uid="a">Hello</p><p data-uid="b">World</p>`);
    const controller = createTextEditController(vi.fn());
    expect(controller.enter('a')).toEqual({ ok: true, text: 'Hello' });
    expect(controller.enter('b')).toEqual({ ok: false, reason: 'already-editing' });
  });
});

describe('createTextEditController — exit()', () => {
  it('commit reads the live DOM text and fires onExit({committed:true, text})', () => {
    fixture(`<p data-uid="a">Hello</p>`);
    const onExit = vi.fn();
    const controller = createTextEditController(onExit);
    controller.enter('a');

    const el = document.querySelector('[data-uid="a"]') as HTMLElement;
    el.textContent = 'Hello world';

    const result = controller.exit(true);
    expect(result).toEqual({ uid: 'a', committed: true, text: 'Hello world' });
    expect(onExit).toHaveBeenCalledWith(result);
    expect(el.getAttribute('contenteditable')).toBeNull();
    expect(el.className).not.toContain('ccs-bridge-editing');
    expect(controller.currentUid()).toBeNull();
  });

  it('cancel restores the original text and fires onExit({committed:false, text:null})', () => {
    fixture(`<p data-uid="a">Hello</p>`);
    const onExit = vi.fn();
    const controller = createTextEditController(onExit);
    controller.enter('a');

    const el = document.querySelector('[data-uid="a"]') as HTMLElement;
    el.textContent = 'typed garbage';

    const result = controller.exit(false);
    expect(result).toEqual({ uid: 'a', committed: false, text: null });
    expect(el.textContent).toBe('Hello');
    expect(onExit).toHaveBeenCalledWith(result);
  });

  it('exit() is a no-op returning null when nothing is being edited', () => {
    fixture(`<p data-uid="a">Hello</p>`);
    const onExit = vi.fn();
    const controller = createTextEditController(onExit);
    expect(controller.exit(true)).toBeNull();
    expect(onExit).not.toHaveBeenCalled();
  });

  it('Enter commits, Escape cancels, blur commits — driven via the real DOM events', () => {
    fixture(`<p data-uid="a">Hello</p>`);
    const onExit = vi.fn();
    const controller = createTextEditController(onExit);
    controller.enter('a');
    const el = document.querySelector('[data-uid="a"]') as HTMLElement;
    el.textContent = 'Hello there';
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(onExit).toHaveBeenCalledWith({ uid: 'a', committed: true, text: 'Hello there' });

    onExit.mockClear();
    controller.enter('a');
    el.textContent = 'more garbage';
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(onExit).toHaveBeenCalledWith({ uid: 'a', committed: false, text: null });
    expect(el.textContent).toBe('Hello there'); // restored to what it was when this 2nd enter() began

    onExit.mockClear();
    controller.enter('a');
    el.textContent = 'blur commit';
    el.dispatchEvent(new FocusEvent('blur'));
    expect(onExit).toHaveBeenCalledWith({ uid: 'a', committed: true, text: 'blur commit' });
  });

  it('Shift+Enter does NOT commit (reserved for a future multi-line case, not treated as plain Enter)', () => {
    fixture(`<p data-uid="a">Hello</p>`);
    const onExit = vi.fn();
    const controller = createTextEditController(onExit);
    controller.enter('a');
    const el = document.querySelector('[data-uid="a"]') as HTMLElement;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    expect(onExit).not.toHaveBeenCalled();
    expect(controller.currentUid()).toBe('a');
  });
});
