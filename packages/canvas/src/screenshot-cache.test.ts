import { describe, expect, it } from 'vitest';
import { createScreenshotCache } from './screenshot-cache.js';

describe('createScreenshotCache', () => {
  it('starts empty and stale for any unknown id', () => {
    const cache = createScreenshotCache();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.isStale('a')).toBe(true);
    expect(cache.currentGeneration('a')).toBe(0);
  });

  it('set() stamps the entry with the current generation', () => {
    const cache = createScreenshotCache();
    cache.set('a', 'data:image/png;base64,AAA');
    expect(cache.get('a')).toEqual({ dataUrl: 'data:image/png;base64,AAA', generation: 0 });
    expect(cache.isStale('a')).toBe(false);
  });

  it('bumpGeneration invalidates a previously-fresh entry', () => {
    const cache = createScreenshotCache();
    cache.set('a', 'shot-1');
    expect(cache.isStale('a')).toBe(false);

    cache.bumpGeneration('a'); // simulates an hmr-update for this frame
    expect(cache.isStale('a')).toBe(true);
    // The stale screenshot is still served — better a slightly outdated
    // shot than nothing while panned away.
    expect(cache.get('a')?.dataUrl).toBe('shot-1');
  });

  it('a fresh capture after bumping generation clears staleness', () => {
    const cache = createScreenshotCache();
    cache.set('a', 'shot-1');
    cache.bumpGeneration('a');
    cache.set('a', 'shot-2');
    expect(cache.isStale('a')).toBe(false);
    expect(cache.get('a')?.dataUrl).toBe('shot-2');
  });

  it('bumpGeneration returns the incremented counter', () => {
    const cache = createScreenshotCache();
    expect(cache.bumpGeneration('a')).toBe(1);
    expect(cache.bumpGeneration('a')).toBe(2);
    expect(cache.currentGeneration('a')).toBe(2);
  });

  it('generations/entries are independent per frame id', () => {
    const cache = createScreenshotCache();
    cache.set('a', 'shot-a');
    cache.bumpGeneration('b');
    expect(cache.isStale('a')).toBe(false);
    expect(cache.get('b')).toBeUndefined();
  });

  it('delete() clears both the entry and its generation counter', () => {
    const cache = createScreenshotCache();
    cache.bumpGeneration('a');
    cache.set('a', 'shot-1');
    cache.delete('a');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.currentGeneration('a')).toBe(0);
  });

  it('clear() resets everything', () => {
    const cache = createScreenshotCache();
    cache.set('a', 'shot-1');
    cache.set('b', 'shot-2');
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });
});
