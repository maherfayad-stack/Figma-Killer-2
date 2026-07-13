import { describe, expect, it } from 'vitest';
import { App } from './App.js';

// No jsdom/testing-library in P0 — real chrome + its render tests land in
// P5 (playbook §4/P5). This just proves the module boots and exports the
// expected shape across the @ccs/* workspace boundary.
describe('App (P0 placeholder)', () => {
  it('exports a component function', () => {
    expect(typeof App).toBe('function');
  });
});
