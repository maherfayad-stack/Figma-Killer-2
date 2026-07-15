// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Tabs } from './Tabs.js';

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(el: React.ReactElement, dir: 'ltr' | 'rtl' = 'ltr') {
  container = document.createElement('div');
  container.dir = dir;
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(el));
}

const items = [
  { id: 'pages', label: 'Pages', content: <div>pages-content</div> },
  { id: 'layers', label: 'Layers', content: <div>layers-content</div> },
  { id: 'assets', label: 'Assets', content: <div>assets-content</div> },
];

describe('Tabs', () => {
  it('renders WAI-ARIA tablist/tab/tabpanel roles', () => {
    mount(<Tabs items={items} ariaLabel="Left dock" />);
    expect(container.querySelector('[role="tablist"]')).not.toBeNull();
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(3);
    expect(container.querySelector('[role="tabpanel"]')?.textContent).toBe('pages-content');
  });

  it('ArrowRight in LTR moves focus/selection to the next tab', () => {
    mount(<Tabs items={items} ariaLabel="Left dock" />, 'ltr');
    const firstTab = container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[0];
    firstTab?.focus();
    act(() => {
      firstTab?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(container.querySelector('[role="tabpanel"]')?.textContent).toBe('layers-content');
  });

  it('ArrowLeft in RTL moves selection forward (flipped vs LTR, where ArrowLeft moves backward)', () => {
    mount(<Tabs items={items} ariaLabel="Left dock" />, 'rtl');
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs[0]?.focus(); // starts on 'pages' (index 0, uncontrolled default)
    act(() => {
      tabs[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    // direction-aware nav: in rtl, ArrowLeft advances toward reading-end => 'layers'.
    expect(container.querySelector('[role="tabpanel"]')?.textContent).toBe('layers-content');
  });
});
