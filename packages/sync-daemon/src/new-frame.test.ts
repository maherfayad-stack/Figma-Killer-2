import { describe, expect, it } from 'vitest';
import {
  buildFrameSource,
  buildNewCanvasJsonEntry,
  frameSourcePath,
  isValidFrameName,
  patchFramesRegistry,
} from './new-frame.js';

// Fixture mirroring `templates/file-app/src/frames.ts` exactly (same
// fixture as `packages/canvas/src/new-frame.test.ts` — BOUNDARIES forbid
// modifying templates/ source; this is a literal copy for golden-style
// patch testing, not a read of the real file).
const FRAMES_REGISTRY_FIXTURE = `import type { ComponentType } from 'react';
import Hero from './frames/Hero.js';
import Pricing from './frames/Pricing.js';

export const frames: Record<string, ComponentType> = {
  Hero,
  Pricing,
};

export function getFrame(name: string | null): ComponentType | null {
  if (!name) return null;
  return frames[name] ?? null;
}

export function listFrameNames(): string[] {
  return Object.keys(frames);
}
`;

describe('isValidFrameName', () => {
  it('accepts PascalCase identifiers', () => {
    expect(isValidFrameName('Hero')).toBe(true);
    expect(isValidFrameName('Pricing2')).toBe(true);
  });

  it('rejects empty, lowercase-first, path separators, and non-identifiers', () => {
    expect(isValidFrameName('')).toBe(false);
    expect(isValidFrameName('hero')).toBe(false);
    expect(isValidFrameName('../etc')).toBe(false);
    expect(isValidFrameName('../../etc/passwd')).toBe(false);
    expect(isValidFrameName('New Frame')).toBe(false);
    expect(isValidFrameName('New-Frame')).toBe(false);
    expect(isValidFrameName('Frame/Nested')).toBe(false);
  });
});

describe('frameSourcePath', () => {
  it('builds the file-folder-relative src/frames path', () => {
    expect(frameSourcePath('Testimonials')).toBe('src/frames/Testimonials.tsx');
  });
});

describe('buildFrameSource', () => {
  it('produces a valid default-exported component using the given name', () => {
    const source = buildFrameSource('Testimonials');
    expect(source).toContain('export default function Testimonials()');
    expect(source).toContain('Testimonials');
  });

  it('is deterministic (same input -> same output)', () => {
    expect(buildFrameSource('Foo')).toBe(buildFrameSource('Foo'));
  });
});

describe('patchFramesRegistry', () => {
  it('inserts the import after the last existing frame import', () => {
    const patched = patchFramesRegistry(FRAMES_REGISTRY_FIXTURE, 'Testimonials');
    const lines = patched.split('\n');
    const pricingIdx = lines.indexOf("import Pricing from './frames/Pricing.js';");
    const newImportIdx = lines.indexOf("import Testimonials from './frames/Testimonials.js';");
    expect(pricingIdx).toBeGreaterThan(-1);
    expect(newImportIdx).toBe(pricingIdx + 1);
  });

  it('adds a registry entry inside the frames object literal', () => {
    const patched = patchFramesRegistry(FRAMES_REGISTRY_FIXTURE, 'Testimonials');
    expect(patched).toContain('export const frames: Record<string, ComponentType> = {\n  Hero,\n  Pricing,\n  Testimonials,\n};');
  });

  it('is idempotent-safe: refuses to double-register the same frame name', () => {
    const once = patchFramesRegistry(FRAMES_REGISTRY_FIXTURE, 'Testimonials');
    expect(() => patchFramesRegistry(once, 'Testimonials')).toThrow(/already registered/);
  });

  it('refuses to patch a file with no frame import at all (unexpected shape)', () => {
    expect(() => patchFramesRegistry('export const frames = {};', 'Testimonials')).toThrow(
      /did not match the expected template shape/,
    );
  });

  it('refuses to patch a file with imports but no registry object literal', () => {
    const noRegistry = `import type { ComponentType } from 'react';
import Hero from './frames/Hero.js';
`;
    expect(() => patchFramesRegistry(noRegistry, 'Pricing')).toThrow(/frames: Record<string, ComponentType>/);
  });
});

describe('buildNewCanvasJsonEntry', () => {
  it('cascades past existing entries using the same convention as the daemon default', () => {
    const existing = [
      { framePath: 'src/frames/Hero.tsx', x: 0, y: 0, w: 1440, h: 900 },
      { framePath: 'src/frames/Pricing.tsx', x: 1600, y: 0, w: 1440, h: 900 },
    ];
    expect(buildNewCanvasJsonEntry(existing, 'Testimonials')).toEqual({
      framePath: 'src/frames/Testimonials.tsx',
      x: 3200,
      y: 0,
      w: 1440,
      h: 900,
    });
  });

  it('positions the first frame in an empty file-folder at the origin', () => {
    expect(buildNewCanvasJsonEntry([], 'Hero')).toEqual({
      framePath: 'src/frames/Hero.tsx',
      x: 0,
      y: 0,
      w: 1440,
      h: 900,
    });
  });
});
