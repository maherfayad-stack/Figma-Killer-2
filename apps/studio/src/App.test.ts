// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { App } from './App.js';

describe('App (P5)', () => {
  it('exports a component function', () => {
    expect(typeof App).toBe('function');
  });
});
