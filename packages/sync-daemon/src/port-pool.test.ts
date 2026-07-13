import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { allocatePort, isPortFree } from './port-pool.js';

describe('isPortFree', () => {
  let server: net.Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  it('is true for an unbound port', async () => {
    expect(await isPortFree(58231)).toBe(true);
  });

  it('is false for a port currently bound on 127.0.0.1', async () => {
    server = net.createServer();
    await new Promise<void>((resolve) => server?.listen(58232, '127.0.0.1', resolve));

    expect(await isPortFree(58232)).toBe(false);
  });
});

describe('allocatePort', () => {
  let server: net.Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
  });

  it('returns the starting port when it is free', async () => {
    expect(await allocatePort(58300)).toBe(58300);
  });

  it('skips a port that is already bound', async () => {
    server = net.createServer();
    await new Promise<void>((resolve) => server?.listen(58301, '127.0.0.1', resolve));

    expect(await allocatePort(58301)).toBe(58302);
  });

  it('skips ports in the `taken` set even if they are not actually bound yet', async () => {
    expect(await allocatePort(58310, new Set([58310, 58311]))).toBe(58312);
  });
});
