import { beforeEach, describe, expect, it } from 'vitest';
import { _resetClassHintsForTest, getClassHint, setClassHint } from './inspector-class-hints.js';

describe('inspector-class-hints', () => {
  beforeEach(() => {
    _resetClassHintsForTest();
  });

  it('returns undefined for a uid/group that was never set (first-ever selection)', () => {
    expect(getClassHint('a.tsx:0', 'text-size')).toBeUndefined();
  });

  it('remembers the last value written for a given uid+group', () => {
    setClassHint('a.tsx:0', 'text-size', 'lg');
    expect(getClassHint('a.tsx:0', 'text-size')).toBe('lg');

    setClassHint('a.tsx:0', 'text-size', 'xl');
    expect(getClassHint('a.tsx:0', 'text-size')).toBe('xl');
  });

  it('keeps different groups on the same uid independent', () => {
    setClassHint('a.tsx:0', 'text-size', 'lg');
    setClassHint('a.tsx:0', 'font-weight', 'bold');
    expect(getClassHint('a.tsx:0', 'text-size')).toBe('lg');
    expect(getClassHint('a.tsx:0', 'font-weight')).toBe('bold');
  });

  it('keeps the same group independent across different uids', () => {
    setClassHint('a.tsx:0', 'text-size', 'lg');
    setClassHint('b.tsx:1', 'text-size', 'sm');
    expect(getClassHint('a.tsx:0', 'text-size')).toBe('lg');
    expect(getClassHint('b.tsx:1', 'text-size')).toBe('sm');
  });
});
