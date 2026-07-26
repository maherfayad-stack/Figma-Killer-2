import { describe, expect, it } from 'vitest';
import { getFrame, listFrameNames } from './frames.js';

describe('frame registry', () => {
  it('lists the seeded frames', () => {
    expect(listFrameNames().sort()).toEqual(['Hero', 'Pricing']);
  });

  it('resolves a known frame by name', () => {
    expect(getFrame('Hero')).toBeTypeOf('function');
    expect(getFrame('Pricing')).toBeTypeOf('function');
  });

  it('returns null for an unknown or missing frame name', () => {
    expect(getFrame('DoesNotExist')).toBeNull();
    expect(getFrame(null)).toBeNull();
  });
});
