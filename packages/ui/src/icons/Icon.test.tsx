// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Icon } from './Icon.js';
import { ICON_PATHS } from './registry.js';

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

describe('Icon', () => {
  it('renders an <svg> with the vendored path data for the requested name', () => {
    mount(<Icon name="board" />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('width')).toBe('16');
    expect(svg?.getAttribute('height')).toBe('16');
    expect(svg?.querySelector('path')?.getAttribute('d')).toBe(ICON_PATHS.board);
  });

  it('sizes to 12/32 via the `size` prop', () => {
    mount(<Icon name="search" size={32} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('32');
    expect(svg?.getAttribute('height')).toBe('32');
  });

  it('follows CSS color (stroke: currentColor, no baked-in fill)', () => {
    mount(<Icon name="lock" />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('stroke')).toBe('currentColor');
    expect(svg?.getAttribute('fill')).toBe('none');
  });

  it('exposes every vendored icon name from the registry', () => {
    // Sanity: the spec's ~29-icon inventory is all present and non-empty.
    expect(Object.keys(ICON_PATHS).length).toBeGreaterThanOrEqual(29);
    for (const d of Object.values(ICON_PATHS)) {
      expect(typeof d).toBe('string');
      expect(d.length).toBeGreaterThan(0);
    }
  });
});
