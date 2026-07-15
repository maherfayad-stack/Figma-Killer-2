// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Input } from './Input.js';

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

describe('Input', () => {
  it('renders a plain text input by default', () => {
    mount(<Input label="Class" defaultValue="flex" onChange={() => {}} />);
    const input = container.querySelector('input');
    expect(input?.value).toBe('flex');
    expect(container.querySelector('[data-testid="token-chip"]')).toBeNull();
  });

  it('renders a token chip instead of a raw input when token-bound (playbook §2.3 token-aware inputs)', () => {
    mount(<Input label="Fill" tokenBinding={{ name: 'color.primary', value: '#7c7cff' }} />);
    expect(container.querySelector('input')).toBeNull();
    const chip = container.querySelector('[data-testid="token-chip"]');
    expect(chip?.textContent).toContain('color.primary');
  });
});
