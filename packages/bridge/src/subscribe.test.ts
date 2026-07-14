// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createRectsSubscription } from './subscribe.js';
import type { Rect } from './protocol.js';

function wait(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createRectsSubscription — rAF-throttled rect streaming', () => {
  it('streams rects for subscribed uids and stops streaming after unsubscribe', async () => {
    document.body.innerHTML = `<div data-uid="a"></div>`;
    const updates: Record<string, Rect | null>[] = [];
    const sub = createRectsSubscription({ onUpdate: (rects) => updates.push(rects) });

    sub.subscribe(['a']);
    await wait();
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[0]!.a).toEqual(expect.objectContaining({ x: expect.any(Number) }));

    const countBeforeUnsubscribe = updates.length;
    sub.unsubscribe();
    window.dispatchEvent(new Event('resize'));
    await wait();

    expect(updates.length).toBe(countBeforeUnsubscribe);
    sub.dispose();
  });

  it('collapses a burst of scroll events between frames into a single update', async () => {
    document.body.innerHTML = `<div data-uid="a"></div>`;
    const updates: Record<string, Rect | null>[] = [];
    const sub = createRectsSubscription({ onUpdate: (rects) => updates.push(rects) });

    sub.subscribe(['a']);
    await wait();
    const countBefore = updates.length;

    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('scroll'));
    await wait();

    expect(updates.length).toBe(countBefore + 1);
    sub.dispose();
  });

  it('re-subscribing with a new uid list streams rects for the new set', async () => {
    document.body.innerHTML = `<div data-uid="a"></div><div data-uid="b"></div>`;
    const updates: Record<string, Rect | null>[] = [];
    const sub = createRectsSubscription({ onUpdate: (rects) => updates.push(rects) });

    sub.subscribe(['a']);
    await wait();
    sub.subscribe(['b']);
    await wait();

    const last = updates[updates.length - 1]!;
    expect(Object.keys(last)).toEqual(['b']);
    sub.dispose();
  });
});
