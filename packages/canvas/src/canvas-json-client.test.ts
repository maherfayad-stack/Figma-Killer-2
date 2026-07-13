import { describe, expect, it } from 'vitest';
import { checkFrameSourceExists, fetchCanvasJson, originOf, type FetchLike } from './canvas-json-client.js';

function fakeFetch(responses: Record<string, { status: number; contentType?: string; body?: unknown }>): FetchLike {
  return async (input: string) => {
    const entry = responses[input];
    if (!entry) {
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        json: async () => {
          throw new Error('no body');
        },
      };
    }
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? entry.contentType ?? null : null) },
      json: async () => entry.body,
    };
  };
}

describe('fetchCanvasJson', () => {
  const validMeta = {
    frames: [{ framePath: 'src/frames/Hero.tsx', x: 0, y: 0, w: 1440, h: 900 }],
    comments: [],
    zoomBookmarks: [],
  };

  it('parses a valid canvas.json response', async () => {
    const fetchImpl = fakeFetch({
      'http://127.0.0.1:5200/.studio/canvas.json': { status: 200, body: validMeta },
    });
    const result = await fetchCanvasJson('http://127.0.0.1:5200', fetchImpl);
    expect(result).toEqual(validMeta);
  });

  it('returns null on a non-2xx response', async () => {
    const fetchImpl = fakeFetch({});
    const result = await fetchCanvasJson('http://127.0.0.1:5200', fetchImpl);
    expect(result).toBeNull();
  });

  it('returns null when the body fails FrameMeta validation', async () => {
    const fetchImpl = fakeFetch({
      'http://127.0.0.1:5200/.studio/canvas.json': { status: 200, body: { frames: 'not-an-array' } },
    });
    const result = await fetchCanvasJson('http://127.0.0.1:5200', fetchImpl);
    expect(result).toBeNull();
  });

  it('returns null when the fetch itself throws (network error)', async () => {
    const throwingFetch: FetchLike = async () => {
      throw new Error('network down');
    };
    const result = await fetchCanvasJson('http://127.0.0.1:5200', throwingFetch);
    expect(result).toBeNull();
  });
});

describe('checkFrameSourceExists', () => {
  it('true when Content-Type is a JS module (existing source file)', async () => {
    const fetchImpl = fakeFetch({
      'http://127.0.0.1:5200/src/frames/Hero.tsx': { status: 200, contentType: 'text/javascript' },
    });
    expect(await checkFrameSourceExists('http://127.0.0.1:5200', 'src/frames/Hero.tsx', fetchImpl)).toBe(true);
  });

  it('true for application/javascript content-type too', async () => {
    const fetchImpl = fakeFetch({
      'http://127.0.0.1:5200/src/frames/Hero.tsx': { status: 200, contentType: 'application/javascript; charset=utf-8' },
    });
    expect(await checkFrameSourceExists('http://127.0.0.1:5200', 'src/frames/Hero.tsx', fetchImpl)).toBe(true);
  });

  it('false when Vite SPA-falls-back to text/html (missing file)', async () => {
    const fetchImpl = fakeFetch({
      'http://127.0.0.1:5200/src/frames/Ghost.tsx': { status: 200, contentType: 'text/html' },
    });
    expect(await checkFrameSourceExists('http://127.0.0.1:5200', 'src/frames/Ghost.tsx', fetchImpl)).toBe(false);
  });

  it('false on network error', async () => {
    const throwingFetch: FetchLike = async () => {
      throw new Error('down');
    };
    expect(await checkFrameSourceExists('http://127.0.0.1:5200', 'src/frames/Hero.tsx', throwingFetch)).toBe(false);
  });
});

describe('originOf', () => {
  it('strips the query string, keeping scheme+host+port', () => {
    expect(originOf('http://127.0.0.1:5200/?frame=Hero')).toBe('http://127.0.0.1:5200');
  });
});
