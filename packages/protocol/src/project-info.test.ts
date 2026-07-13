import { describe, expect, it } from 'vitest';
import { ProjectInfoSchema, ProjectInfoFrameSchema } from './project-info.js';

describe('ProjectInfoFrameSchema', () => {
  it('accepts the ADR-0012 bootstrap frame shape', () => {
    const frame = {
      framePath: 'files/demo/src/frames/Hero.tsx',
      name: 'Hero',
      devServerUrl: 'http://127.0.0.1:5200/?frame=Hero',
    };
    expect(ProjectInfoFrameSchema.parse(frame)).toEqual(frame);
  });

  it('accepts Arabic frame names/paths byte-exact (playbook §5.9)', () => {
    const frame = {
      framePath: 'files/demo/src/frames/الأسعار.tsx',
      name: 'الأسعار',
      devServerUrl: 'http://127.0.0.1:5201/?frame=%D8%A7%D9%84%D8%A3%D8%B3%D8%B9%D8%A7%D8%B1',
    };
    expect(ProjectInfoFrameSchema.parse(frame)).toEqual(frame);
  });

  it('rejects an empty framePath/name/devServerUrl', () => {
    expect(() =>
      ProjectInfoFrameSchema.parse({ framePath: '', name: 'Hero', devServerUrl: 'http://x' }),
    ).toThrow();
    expect(() =>
      ProjectInfoFrameSchema.parse({ framePath: 'a.tsx', name: '', devServerUrl: 'http://x' }),
    ).toThrow();
    expect(() =>
      ProjectInfoFrameSchema.parse({ framePath: 'a.tsx', name: 'A', devServerUrl: '' }),
    ).toThrow();
  });

  it('rejects unknown extra fields (strict)', () => {
    expect(() =>
      ProjectInfoFrameSchema.parse({
        framePath: 'a.tsx',
        name: 'A',
        devServerUrl: 'http://x',
        extra: true,
      }),
    ).toThrow();
  });
});

describe('ProjectInfoSchema', () => {
  it('parses the exact ADR-0012 bootstrap message shape (no envelope)', () => {
    const bootstrap = {
      frames: [
        {
          framePath: 'files/demo/src/frames/Hero.tsx',
          name: 'Hero',
          devServerUrl: 'http://127.0.0.1:5200/?frame=Hero',
        },
        {
          framePath: 'files/demo/src/frames/Pricing.tsx',
          name: 'Pricing',
          devServerUrl: 'http://127.0.0.1:5200/?frame=Pricing',
        },
      ],
      daemonPort: 4700,
    };
    expect(ProjectInfoSchema.parse(bootstrap)).toEqual(bootstrap);
  });

  it('accepts an empty frames array (project with no frames yet)', () => {
    expect(ProjectInfoSchema.parse({ frames: [], daemonPort: 4700 })).toEqual({
      frames: [],
      daemonPort: 4700,
    });
  });

  it('rejects a non-positive or non-integer daemonPort', () => {
    expect(() => ProjectInfoSchema.parse({ frames: [], daemonPort: 0 })).toThrow();
    expect(() => ProjectInfoSchema.parse({ frames: [], daemonPort: -1 })).toThrow();
    expect(() => ProjectInfoSchema.parse({ frames: [], daemonPort: 4700.5 })).toThrow();
  });

  it('rejects a message carrying a `t` discriminant (must stay distinguishable from DaemonEvent)', () => {
    expect(() => ProjectInfoSchema.parse({ t: 'file-changed', frames: [], daemonPort: 4700 })).toThrow();
  });

  it('rejects missing fields (strict)', () => {
    expect(() => ProjectInfoSchema.parse({ daemonPort: 4700 })).toThrow();
    expect(() => ProjectInfoSchema.parse({ frames: [] })).toThrow();
  });
});
