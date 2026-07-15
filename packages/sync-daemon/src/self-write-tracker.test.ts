import { describe, expect, it } from 'vitest';
import { SelfWriteTracker } from './self-write-tracker.js';

describe('SelfWriteTracker', () => {
  it('consume returns false for a path never marked', () => {
    const tracker = new SelfWriteTracker();
    expect(tracker.consume('/a/b.tsx')).toBe(false);
  });

  it('consume returns true exactly once per markWritten call', () => {
    const tracker = new SelfWriteTracker();
    tracker.markWritten('/a/b.tsx');
    expect(tracker.consume('/a/b.tsx')).toBe(true);
    expect(tracker.consume('/a/b.tsx')).toBe(false);
  });

  it('survives back-to-back writes to the same path before either is consumed', () => {
    const tracker = new SelfWriteTracker();
    tracker.markWritten('/a/b.tsx');
    tracker.markWritten('/a/b.tsx');
    expect(tracker.consume('/a/b.tsx')).toBe(true);
    expect(tracker.consume('/a/b.tsx')).toBe(true);
    expect(tracker.consume('/a/b.tsx')).toBe(false);
  });

  it('tracks distinct paths independently', () => {
    const tracker = new SelfWriteTracker();
    tracker.markWritten('/a/b.tsx');
    expect(tracker.consume('/a/c.tsx')).toBe(false);
    expect(tracker.consume('/a/b.tsx')).toBe(true);
  });
});
