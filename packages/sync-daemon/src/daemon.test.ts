import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { DaemonEvent, ProjectInfo } from '@ccs/protocol';
import { openProject, type DaemonHandle, type StartViteServerFn } from './daemon.js';
import { readCanvasJson } from './canvas-json.js';
import { readDaemonCoordFile } from './coord-file.js';

/**
 * Fake Vite starter — a bare HTTP server standing in for a real `vite`
 * process. Keeps this suite fast/hermetic while still exercising every
 * other piece of `openProject`'s wiring for real: port allocation,
 * canvas.json reconciliation, the control ws, chokidar watchers, the
 * geometry writer, and the `.studio/daemon.json` coord file. The real
 * `startViteServer` (actual `vite` CLI) is covered separately in
 * `vite-orchestrator.test.ts` and the demo script.
 */
function makeFakeStartVite(): { startVite: StartViteServerFn; stopAll: () => Promise<void> } {
  const stops: Array<() => Promise<void>> = [];
  const startVite: StartViteServerFn = async ({ port }) => {
    const http = await import('node:http');
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>fake vite</body></html>');
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    stops.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return {
      port,
      host: '127.0.0.1',
      pid: 12345,
      url: `http://127.0.0.1:${port}`,
      process: {} as never,
      stop: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  };
  return { startVite, stopAll: async () => Promise.all(stops.map((s) => s())).then(() => undefined) };
}

async function connectAndGetBootstrap(port: number): Promise<{ socket: WebSocket; bootstrap: ProjectInfo }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const bootstrap = await new Promise<ProjectInfo>((resolve, reject) => {
    socket.once('message', (data) => resolve(JSON.parse(data.toString())));
    socket.once('error', reject);
  });
  return { socket, bootstrap };
}

function nextEvent(socket: WebSocket): Promise<DaemonEvent> {
  return new Promise((resolve) => socket.once('message', (data) => resolve(JSON.parse(data.toString()))));
}

describe('openProject', () => {
  let projectRoot: string;
  let daemon: DaemonHandle | undefined;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'ccs-daemon-'));
    await mkdir(join(projectRoot, 'files', 'demo', 'src', 'frames'), { recursive: true });
    await writeFile(
      join(projectRoot, 'files', 'demo', 'src', 'frames', 'Hero.tsx'),
      'export default function Hero() { return null; }\n',
    );
    await writeFile(
      join(projectRoot, 'files', 'demo', 'src', 'frames', 'Pricing.tsx'),
      '// dir="rtl" lang="ar" — Arabic fixture frame (playbook §5.9)\nexport default function Pricing() { return null; }\n',
    );
    // Every real file-folder has a src/frames.ts registry (templates/file-app
    // convention) — needed by the ADR-0014 create-frame tests below; harmless
    // to the pre-existing tests, none of which read this file.
    await writeFile(
      join(projectRoot, 'files', 'demo', 'src', 'frames.ts'),
      `import type { ComponentType } from 'react';
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
`,
    );
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.close();
      daemon = undefined;
    }
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('scans frames, reconciles canvas.json, allocates ports from 5200+, and boots a server per file-folder', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 59700,
      frameServerPortStart: 59720,
    });

    expect(daemon.fileFolders).toHaveLength(1);
    expect(daemon.fileFolders[0]?.name).toBe('demo');
    expect(daemon.fileFolders[0]?.port).toBeGreaterThanOrEqual(59720);
    expect(daemon.fileFolders[0]?.frameNames.sort()).toEqual(['Hero', 'Pricing']);

    const meta = await readCanvasJson(join(projectRoot, 'files', 'demo'));
    expect(meta.frames.map((f) => f.framePath).sort()).toEqual([
      'src/frames/Hero.tsx',
      'src/frames/Pricing.tsx',
    ]);

    await stopAll();
  });

  it('sends the ADR-0012 bootstrap with per-frame devServerUrl including ?frame=<Name>', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({ projectRoot, startVite, daemonPortStart: 59730, frameServerPortStart: 59740 });

    const { socket, bootstrap } = await connectAndGetBootstrap(daemon.daemonPort);
    socket.terminate();

    expect(bootstrap.daemonPort).toBe(daemon.daemonPort);
    const names = bootstrap.frames.map((f) => f.name).sort();
    expect(names).toEqual(['Hero', 'Pricing']);
    const hero = bootstrap.frames.find((f) => f.name === 'Hero');
    expect(hero?.devServerUrl).toMatch(/\?frame=Hero$/);
    expect(hero?.framePath).toBe('files/demo/src/frames/Hero.tsx');

    await stopAll();
  });

  it('writeGeometry persists x/y/w/h atomically and broadcasts file-changed', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 59750,
      frameServerPortStart: 59760,
      geometryDebounceMs: 10,
    });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const before = await readCanvasJson(join(projectRoot, 'files', 'demo'));

    const pendingEvent = nextEvent(socket);
    await daemon.writeGeometry('demo', 'src/frames/Hero.tsx', { x: 123, y: 456, w: 200, h: 150 });
    const event = await pendingEvent;

    const after = await readCanvasJson(join(projectRoot, 'files', 'demo'));
    const heroBefore = before.frames.find((f) => f.framePath === 'src/frames/Hero.tsx');
    const heroAfter = after.frames.find((f) => f.framePath === 'src/frames/Hero.tsx');

    expect(heroAfter).toEqual({ framePath: 'src/frames/Hero.tsx', x: 123, y: 456, w: 200, h: 150 });
    expect(heroAfter).not.toEqual(heroBefore);
    expect(event).toEqual({ t: 'file-changed', file: 'files/demo/.studio/canvas.json' });

    socket.terminate();
    await stopAll();
  });

  it('broadcasts file-changed + hmr-update when a frame file is edited on disk', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({ projectRoot, startVite, daemonPortStart: 59770, frameServerPortStart: 59780 });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const received: DaemonEvent[] = [];
    socket.on('message', (data) => received.push(JSON.parse(data.toString())));

    await writeFile(
      join(projectRoot, 'files', 'demo', 'src', 'frames', 'Hero.tsx'),
      'export default function Hero() { return "edited"; }\n',
    );

    await vi.waitFor(
      () => {
        expect(received).toContainEqual({ t: 'hmr-update', file: 'files/demo/src/frames/Hero.tsx' });
      },
      { timeout: 3000, interval: 30 },
    );

    socket.terminate();
    await stopAll();
  });

  it('broadcasts file-changed when a frame file is added or removed', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({ projectRoot, startVite, daemonPortStart: 59790, frameServerPortStart: 59800 });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const received: DaemonEvent[] = [];
    socket.on('message', (data) => received.push(JSON.parse(data.toString())));

    await writeFile(
      join(projectRoot, 'files', 'demo', 'src', 'frames', 'NewOne.tsx'),
      'export default function NewOne() { return null; }\n',
    );

    await vi.waitFor(
      () => {
        expect(received).toContainEqual({ t: 'file-changed', file: 'files/demo/src/frames/NewOne.tsx' });
      },
      { timeout: 3000, interval: 30 },
    );

    socket.terminate();
    await stopAll();
  });

  it('broadcasts tokens-changed/components-changed on design-system edits', async () => {
    await mkdir(join(projectRoot, 'design-system', 'tokens'), { recursive: true });
    await writeFile(join(projectRoot, 'design-system', 'tokens', 'tokens.json'), '{}');

    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({ projectRoot, startVite, daemonPortStart: 59810, frameServerPortStart: 59820 });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const received: DaemonEvent[] = [];
    socket.on('message', (data) => received.push(JSON.parse(data.toString())));

    await writeFile(join(projectRoot, 'design-system', 'tokens', 'tokens.json'), '{"color":"blue"}');

    await vi.waitFor(
      () => {
        expect(received).toContainEqual({ t: 'tokens-changed' });
      },
      { timeout: 3000, interval: 30 },
    );

    socket.terminate();
    await stopAll();
  });

  it('replies op-rejected with reason "ast-engine P3" for a canvas-op (P1 no-op stub)', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({ projectRoot, startVite, daemonPortStart: 59830, frameServerPortStart: 59840 });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const pending = nextEvent(socket);
    socket.send(
      JSON.stringify({
        kind: 'canvas-op',
        opId: 'op-x',
        op: { t: 'set-text', uid: 'src/frames/Hero.tsx:JSXElement[0]', text: 'hi' },
      }),
    );

    expect(await pending).toEqual({ t: 'op-rejected', opId: 'op-x', reason: 'ast-engine P3' });

    socket.terminate();
    await stopAll();
  });

  it('serializes ops targeting the same file (per-file queue) in arrival order', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({ projectRoot, startVite, daemonPortStart: 59850, frameServerPortStart: 59860 });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const events: DaemonEvent[] = [];
    socket.on('message', (data) => events.push(JSON.parse(data.toString())));

    socket.send(
      JSON.stringify({
        kind: 'canvas-op',
        opId: 'first',
        op: { t: 'set-text', uid: 'src/frames/Hero.tsx:JSXElement[0]', text: 'a' },
      }),
    );
    socket.send(
      JSON.stringify({
        kind: 'canvas-op',
        opId: 'second',
        op: { t: 'set-text', uid: 'src/frames/Hero.tsx:JSXElement[0]', text: 'b' },
      }),
    );

    await vi.waitFor(
      () => {
        const rejected = events.filter((e) => e.t === 'op-rejected');
        expect(rejected.map((e) => (e as { opId: string }).opId)).toEqual(['first', 'second']);
      },
      { timeout: 3000, interval: 30 },
    );

    socket.terminate();
    await stopAll();
  });

  it('writes .studio/daemon.json with ports/pids only, and removes it on close', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({ projectRoot, startVite, daemonPortStart: 59870, frameServerPortStart: 59880 });

    const coord = await readDaemonCoordFile(projectRoot);
    expect(coord).toMatchObject({
      daemonPort: daemon.daemonPort,
      fileFolders: [{ name: 'demo', port: daemon.fileFolders[0]?.port }],
    });
    expect(coord).not.toHaveProperty('frames'); // no design/scene state
    const raw = await readFile(join(projectRoot, '.studio', 'daemon.json'), 'utf8');
    expect(raw).not.toContain('canvas'); // sanity: no spatial/scene data leaked in here

    await daemon.close();
    const daemonRef = daemon;
    daemon = undefined;
    void daemonRef;

    expect(await readDaemonCoordFile(projectRoot)).toBeNull();
    await stopAll();
  });

  it('ADR-0014: create-frame writes the three artifacts and broadcasts two file-changed events', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({ projectRoot, startVite, daemonPortStart: 59910, frameServerPortStart: 59920 });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const received: DaemonEvent[] = [];
    socket.on('message', (data) => received.push(JSON.parse(data.toString())));

    socket.send(JSON.stringify({ kind: 'create-frame', requestId: 'req-1', fileFolder: 'demo', name: 'Testimonials' }));

    await vi.waitFor(
      () => {
        expect(received).toContainEqual({ t: 'file-changed', file: 'files/demo/src/frames/Testimonials.tsx' });
        expect(received).toContainEqual({ t: 'file-changed', file: 'files/demo/.studio/canvas.json' });
      },
      { timeout: 3000, interval: 30 },
    );

    const tsxContent = await readFile(join(projectRoot, 'files', 'demo', 'src', 'frames', 'Testimonials.tsx'), 'utf8');
    expect(tsxContent).toContain('export default function Testimonials()');

    const registry = await readFile(join(projectRoot, 'files', 'demo', 'src', 'frames.ts'), 'utf8');
    expect(registry).toContain("import Testimonials from './frames/Testimonials.js';");

    const meta = await readCanvasJson(join(projectRoot, 'files', 'demo'));
    expect(meta.frames.some((f) => f.framePath === 'src/frames/Testimonials.tsx')).toBe(true);

    socket.terminate();
    await stopAll();
  });

  it('ADR-0014: create-frame rejects an invalid name with a direct control-error reply (no broadcast)', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({ projectRoot, startVite, daemonPortStart: 59930, frameServerPortStart: 59940 });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const pending = nextEvent(socket);
    socket.send(JSON.stringify({ kind: 'create-frame', requestId: 'req-2', fileFolder: 'demo', name: '../../etc/passwd' }));

    const reply = await pending;
    expect(reply).toMatchObject({ kind: 'control-error', requestId: 'req-2' });
    expect((reply as { reason: string }).reason).toMatch(/invalid frame name/);

    socket.terminate();
    await stopAll();
  });

  it('ADR-0014: create-frame rejects a duplicate frame name', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({ projectRoot, startVite, daemonPortStart: 59950, frameServerPortStart: 59960 });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    socket.send(JSON.stringify({ kind: 'create-frame', requestId: 'req-a', fileFolder: 'demo', name: 'Dup' }));
    await vi.waitFor(async () => {
      const meta = await readCanvasJson(join(projectRoot, 'files', 'demo'));
      expect(meta.frames.some((f) => f.framePath === 'src/frames/Dup.tsx')).toBe(true);
    });

    const pending = nextEvent(socket);
    socket.send(JSON.stringify({ kind: 'create-frame', requestId: 'req-b', fileFolder: 'demo', name: 'Dup' }));
    const reply = await pending;
    expect(reply).toMatchObject({ kind: 'control-error', requestId: 'req-b' });

    socket.terminate();
    await stopAll();
  });

  it('ADR-0014: create-frame rejects an unknown file-folder', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({ projectRoot, startVite, daemonPortStart: 59970, frameServerPortStart: 59980 });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const pending = nextEvent(socket);
    socket.send(JSON.stringify({ kind: 'create-frame', requestId: 'req-3', fileFolder: 'nonexistent', name: 'X' }));

    const reply = await pending;
    expect(reply).toMatchObject({ kind: 'control-error', requestId: 'req-3' });
    expect((reply as { reason: string }).reason).toMatch(/unknown file-folder/);

    socket.terminate();
    await stopAll();
  });

  it('ADR-0014: get-canvas-json round-trips the current FrameMeta for a file-folder', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({ projectRoot, startVite, daemonPortStart: 59990, frameServerPortStart: 60000 });

    const onDisk = await readCanvasJson(join(projectRoot, 'files', 'demo'));

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const pending = nextEvent(socket);
    socket.send(JSON.stringify({ kind: 'get-canvas-json', requestId: 'req-4', fileFolder: 'demo' }));

    const reply = await pending;
    expect(reply).toEqual({ kind: 'get-canvas-json-result', requestId: 'req-4', fileFolder: 'demo', meta: onDisk });

    socket.terminate();
    await stopAll();
  });

  it('ADR-0014: get-canvas-json reflects a create-frame that was queued just before it (per-file-folder ordering)', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({ projectRoot, startVite, daemonPortStart: 60010, frameServerPortStart: 60020 });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const received: unknown[] = [];
    socket.on('message', (data) => received.push(JSON.parse(data.toString())));

    // create-frame's own two file-changed broadcasts land on this same
    // socket ahead of the get-canvas-json-result reply (both requests are
    // queued on the same file-folder key, in arrival order) — so this
    // waits for the specific reply by shape rather than "the next message".
    socket.send(JSON.stringify({ kind: 'create-frame', requestId: 'req-c', fileFolder: 'demo', name: 'QueueOrder' }));
    socket.send(JSON.stringify({ kind: 'get-canvas-json', requestId: 'req-d', fileFolder: 'demo' }));

    await vi.waitFor(() => {
      expect(received).toContainEqual(
        expect.objectContaining({ kind: 'get-canvas-json-result', requestId: 'req-d' }),
      );
    });

    const reply = received.find(
      (m): m is { kind: string; meta?: { frames: Array<{ framePath: string }> } } =>
        typeof m === 'object' && m !== null && (m as { kind?: unknown }).kind === 'get-canvas-json-result',
    );
    expect(reply?.meta?.frames.some((f) => f.framePath === 'src/frames/QueueOrder.tsx')).toBe(true);

    socket.terminate();
    await stopAll();
  });

  it('close() stops watchers/servers so a second openProject can reuse the same ports', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    const first = await openProject({ projectRoot, startVite, daemonPortStart: 59890, frameServerPortStart: 59900 });
    const firstDaemonPort = first.daemonPort;
    await first.close();

    const { startVite: startVite2, stopAll: stopAll2 } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite: startVite2,
      daemonPortStart: firstDaemonPort,
      frameServerPortStart: 59900,
    });

    expect(daemon.daemonPort).toBe(firstDaemonPort);
    await stopAll();
    await stopAll2();
  });
});
