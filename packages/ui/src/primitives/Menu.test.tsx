// @vitest-environment jsdom
import { describe, expect, it, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ContextMenu, DropdownMenu } from './Menu.js';

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(el: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(el));
}

describe('ContextMenu', () => {
  it('opens on right-click at the pointer position and closes on Escape', () => {
    mount(
      <ContextMenu items={[{ id: 'dup', label: 'Duplicate', onSelect: () => {} }]}>
        <div style={{ inlineSize: 100, blockSize: 100 }}>surface</div>
      </ContextMenu>,
    );
    expect(container.querySelector('[data-testid="context-menu"]')).toBeNull();

    const surface = container.querySelector('div')!;
    act(() => {
      surface.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    });
    expect(container.querySelector('[data-testid="context-menu"]')).not.toBeNull();
    expect(container.querySelector('[role="menuitem"]')?.textContent).toBe('Duplicate');

    const menu = container.querySelector('[role="menu"]')!;
    act(() => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('[data-testid="context-menu"]')).toBeNull();
  });

  it('invokes onSelect and closes when a menu item is clicked', () => {
    const onSelect = vi.fn();
    mount(
      <ContextMenu items={[{ id: 'del', label: 'Delete', onSelect }]}>
        <div>surface</div>
      </ContextMenu>,
    );
    const surface = container.querySelector('div')!;
    act(() => surface.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
    const item = container.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    act(() => item.click());
    expect(onSelect).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="context-menu"]')).toBeNull();
  });
});

describe('DropdownMenu', () => {
  it('toggles open/closed via the trigger and closes on outside click', () => {
    mount(
      <DropdownMenu
        trigger={(p) => (
          <button type="button" onClick={p.onClick} aria-expanded={p['aria-expanded']}>
            Menu
          </button>
        )}
        items={[{ id: 'a', label: 'A', onSelect: () => {} }]}
      />,
    );
    const trigger = container.querySelector('button')!;
    expect(container.querySelector('[role="menu"]')).toBeNull();
    act(() => trigger.click());
    expect(container.querySelector('[role="menu"]')).not.toBeNull();

    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });
});
