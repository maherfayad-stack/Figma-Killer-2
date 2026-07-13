import { describe, expect, it } from 'vitest';
import { NodeUidSchema, isNodeUid } from './uid.js';

describe('NodeUid', () => {
  it('accepts a well-formed uid', () => {
    const uid = 'src/frames/Hero.tsx:JSXElement[3].children[1]';
    expect(NodeUidSchema.parse(uid)).toBe(uid);
    expect(isNodeUid(uid)).toBe(true);
  });

  it('accepts a nested relPath', () => {
    const uid = 'files/landing-page/src/frames/Pricing.tsx:JSXElement[0]';
    expect(() => NodeUidSchema.parse(uid)).not.toThrow();
  });

  it('rejects a path missing the .tsx marker', () => {
    expect(() => NodeUidSchema.parse('src/frames/Hero.jsx:JSXElement[3]')).toThrow();
  });

  it('rejects a path with no astPath after the colon', () => {
    expect(() => NodeUidSchema.parse('src/frames/Hero.tsx:')).toThrow();
  });

  it('rejects a path with no relPath before .tsx', () => {
    expect(() => NodeUidSchema.parse('.tsx:JSXElement[0]')).toThrow();
  });

  it('rejects non-string input', () => {
    expect(() => NodeUidSchema.parse(42)).toThrow();
    expect(isNodeUid(42)).toBe(false);
  });

  it('rejects a plain string with no colon at all', () => {
    expect(() => NodeUidSchema.parse('src/frames/Hero.tsx')).toThrow();
  });
});
