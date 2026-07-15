// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Button } from './Button.js';

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

describe('Button', () => {
  it('renders as a native <button> with the requested variant', () => {
    mount(<Button variant="primary">Save</Button>);
    const btn = container.querySelector('button');
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toBe('Save');
    expect(btn?.dataset['ccsVariant']).toBe('primary');
  });

  it('reflects `active` via aria-pressed (toolbar tool-switcher semantics)', () => {
    mount(<Button active>Select</Button>);
    expect(container.querySelector('button')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('disables interaction when `disabled`', () => {
    mount(<Button disabled>Delete</Button>);
    expect(container.querySelector('button')?.disabled).toBe(true);
  });
});
