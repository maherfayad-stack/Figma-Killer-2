import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import simpleGit from 'simple-git';
import { buildTree } from '@ccs/ast-engine';
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
function makeFakeStartVite(): {
  startVite: StartViteServerFn;
  stopAll: () => Promise<void>;
  calls: Array<{ cwd: string; port: number; studioConfigPath: string | undefined }>;
} {
  const stops: Array<() => Promise<void>> = [];
  const calls: Array<{ cwd: string; port: number; studioConfigPath: string | undefined }> = [];
  const startVite: StartViteServerFn = async ({ cwd, port, studioConfigPath }) => {
    calls.push({ cwd, port, studioConfigPath });
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
  return {
    startVite,
    stopAll: async () => Promise.all(stops.map((s) => s())).then(() => undefined),
    calls,
  };
}

async function connectAndGetBootstrap(
  port: number,
): Promise<{ socket: WebSocket; bootstrap: ProjectInfo }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const bootstrap = await new Promise<ProjectInfo>((resolve, reject) => {
    socket.once('message', (data) => resolve(JSON.parse(data.toString())));
    socket.once('error', reject);
  });
  return { socket, bootstrap };
}

/**
 * Connects and immediately attaches ONE persistent accumulator — BEFORE
 * any `await`, so it can never race against `getInitialEvents`'s replay
 * (bootstrap + any queued `tree-snapshot`s, sent back-to-back in the same
 * synchronous `connection` handler turn — see `ws-server.ts`). Using
 * `connectAndGetBootstrap`'s separate `.once('message', ...)` followed by a
 * LATER `.on('message', ...)` attach has an inherent gap between them (the
 * `await` yields to the event loop) that can silently drop a message that
 * arrives in that gap — exactly the flake the dedicated tree-snapshot tests
 * below need to avoid. The returned array's first entry is always the bare
 * `ProjectInfo` bootstrap (no `t` field).
 */
function connectAndCollect(port: number): { socket: WebSocket; events: DaemonEvent[] } {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const events: DaemonEvent[] = [];
  socket.on('message', (data) => {
    const parsed = JSON.parse(data.toString());
    if ('t' in parsed) events.push(parsed);
  });
  return { socket, events };
}

/**
 * Waits for the next `DaemonEvent`, SKIPPING any `tree-snapshot` — P5's
 * per-connection `getInitialEvents` replay (`ws-server.ts`) can now queue
 * one right after the bootstrap `ProjectInfo` for any fixture file that
 * already parses as valid JSX at connect-time (several tests below write a
 * real JSX fixture BEFORE calling `openProject`). None of the pre-existing
 * assertions using this helper are testing tree-snapshot content — that's
 * covered by dedicated tree-snapshot tests — so this helper stays blind to
 * it rather than becoming racy against whether the replay lands before or
 * after a given `.once('message', ...)` attaches.
 */
function nextEvent(socket: WebSocket): Promise<DaemonEvent> {
  return new Promise((resolve) => {
    const handler = (data: RawData): void => {
      const event = JSON.parse(data.toString()) as DaemonEvent;
      if (event.t === 'tree-snapshot') {
        socket.once('message', handler);
        return;
      }
      resolve(event);
    };
    socket.once('message', handler);
  });
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
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 59730,
      frameServerPortStart: 59740,
    });

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
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 59770,
      frameServerPortStart: 59780,
    });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const received: DaemonEvent[] = [];
    socket.on('message', (data) => received.push(JSON.parse(data.toString())));

    await writeFile(
      join(projectRoot, 'files', 'demo', 'src', 'frames', 'Hero.tsx'),
      'export default function Hero() { return "edited"; }\n',
    );

    await vi.waitFor(
      () => {
        expect(received).toContainEqual({
          t: 'hmr-update',
          file: 'files/demo/src/frames/Hero.tsx',
        });
      },
      { timeout: 3000, interval: 30 },
    );

    socket.terminate();
    await stopAll();
  });

  it('broadcasts file-changed when a frame file is added or removed', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 59790,
      frameServerPortStart: 59800,
    });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const received: DaemonEvent[] = [];
    socket.on('message', (data) => received.push(JSON.parse(data.toString())));

    await writeFile(
      join(projectRoot, 'files', 'demo', 'src', 'frames', 'NewOne.tsx'),
      'export default function NewOne() { return null; }\n',
    );

    await vi.waitFor(
      () => {
        expect(received).toContainEqual({
          t: 'file-changed',
          file: 'files/demo/src/frames/NewOne.tsx',
        });
      },
      { timeout: 3000, interval: 30 },
    );

    socket.terminate();
    await stopAll();
  });

  it('broadcasts tokens-changed/components-changed on design-system edits', async () => {
    // P4 (ADR-0010/ADR-0022): the daemon's `onDesignSystemEvent` now runs the
    // real `@ccs/tokens` rebuild pipeline on a `tokens-changed` watch signal
    // and only re-broadcasts it once that rebuild SUCCEEDS (a malformed edit
    // shouldn't tell clients "tokens changed" for a rebuild that produced
    // nothing) — so the fixture must be a real, parseable
    // `design-system/src/tokens/tokens.js` (the ADR-0010 primary format),
    // not an arbitrary `tokens.json` (this test predates P4 and used a path
    // the real pipeline never reads).
    await mkdir(join(projectRoot, 'design-system', 'src', 'tokens'), { recursive: true });
    await mkdir(join(projectRoot, 'design-system', 'src', 'components'), { recursive: true });
    await writeFile(
      join(projectRoot, 'design-system', 'src', 'tokens', 'tokens.js'),
      'export const colors = { blue: "#0000ff" };\n',
    );

    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 59810,
      frameServerPortStart: 59820,
    });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const received: DaemonEvent[] = [];
    socket.on('message', (data) => received.push(JSON.parse(data.toString())));

    await writeFile(
      join(projectRoot, 'design-system', 'src', 'tokens', 'tokens.js'),
      'export const colors = { blue: "#00ff00" };\n',
    );

    await vi.waitFor(
      () => {
        expect(received).toContainEqual({ t: 'tokens-changed' });
      },
      { timeout: 3000, interval: 30 },
    );

    // A components-dir edit (no "token" in the path) broadcasts
    // components-changed straight through (no P4 rebuild gate for it —
    // the component catalog reads meta.ts on demand, per `watcher.ts`).
    received.length = 0;
    await writeFile(
      join(projectRoot, 'design-system', 'src', 'components', 'Badge.meta.ts'),
      'export const meta = {};\n',
    );

    await vi.waitFor(
      () => {
        expect(received).toContainEqual({ t: 'components-changed' });
      },
      { timeout: 3000, interval: 30 },
    );

    socket.terminate();
    await stopAll();
  });

  // ---- P3: real AST write-back (playbook §4/P3, ADR-0018/0019) ----------
  //
  // Fixture with a static child (h1, astPath "d0.0") and a dynamic child
  // (a `.map()`-produced <span>, astPath "d0.1") — lets these tests
  // exercise both a successful structural op (with a real uid-remap) and
  // the `dynamic-locked` refusal against the SAME file.
  const HERO_JSX_SOURCE = `export default function Hero() {
  return (
    <div>
      <h1>Title</h1>
      {[1, 2].map((i) => (
        <span key={i}>{i}</span>
      ))}
    </div>
  );
}
`;
  const HERO_ABS = () => join(projectRoot, 'files', 'demo', 'src', 'frames', 'Hero.tsx');
  const HERO_PROJECT_REL = 'files/demo/src/frames/Hero.tsx';
  const HERO_FF_REL = 'src/frames/Hero.tsx';

  // ---- P5: tree-snapshot emission (STATE.md "P5 RESUME HERE" item 1) ----

  it('P5 tree-snapshot: a newly-connecting client receives the live tree for every frame already on disk at project-open', async () => {
    await writeFile(HERO_ABS(), HERO_JSX_SOURCE);
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 59900,
      frameServerPortStart: 59910,
    });

    const { socket, events } = connectAndCollect(daemon.daemonPort);

    await vi.waitFor(
      () => {
        expect(events.some((e) => e.t === 'tree-snapshot' && e.file === HERO_FF_REL)).toBe(true);
      },
      { timeout: 3000, interval: 30 },
    );

    const snapshot = events.find(
      (e) => e.t === 'tree-snapshot' && e.file === HERO_FF_REL,
    ) as Extract<DaemonEvent, { t: 'tree-snapshot' }>;
    // Byte-identical to what ast-engine's own `buildTree` produces on the
    // SAME source — proves the daemon isn't reimplementing uid derivation,
    // just reading the file and delegating (ADR-0017).
    expect(snapshot.tree).toEqual(buildTree(HERO_JSX_SOURCE, HERO_FF_REL));

    socket.terminate();
    await stopAll();
  });

  it('P5 tree-snapshot: editing a frame file on disk broadcasts a fresh live tree matching buildTree on the new source', async () => {
    await writeFile(HERO_ABS(), HERO_JSX_SOURCE);
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 59920,
      frameServerPortStart: 59930,
      treeSnapshotDebounceMs: 20,
    });

    const { socket, events } = connectAndCollect(daemon.daemonPort);

    // Drain the project-open replay first so the assertion below only sees
    // the snapshot produced by the edit below.
    await vi.waitFor(
      () => expect(events.some((e) => e.t === 'tree-snapshot')).toBe(true),
      { timeout: 3000, interval: 30 },
    );
    events.length = 0;

    const EDITED_SOURCE = `export default function Hero() {
  return (
    <div>
      <h1>Title</h1>
      <p>New paragraph</p>
      {[1, 2].map((i) => (
        <span key={i}>{i}</span>
      ))}
    </div>
  );
}
`;
    await writeFile(HERO_ABS(), EDITED_SOURCE);

    await vi.waitFor(
      () => expect(events.some((e) => e.t === 'tree-snapshot')).toBe(true),
      { timeout: 3000, interval: 30 },
    );

    const snapshot = events.find((e) => e.t === 'tree-snapshot') as Extract<
      DaemonEvent,
      { t: 'tree-snapshot' }
    >;
    expect(snapshot.file).toBe(HERO_FF_REL); // file-folder-relative (ADR-0018 item 5 precedent), not project-relative
    expect(snapshot.tree).toEqual(buildTree(EDITED_SOURCE, HERO_FF_REL));
    // The new <p> node's uid matches the EXACT astPath buildTree/the P2
    // bridge/applyOp's resolver would all independently derive for it.
    expect(snapshot.tree.children[1]?.tag).toBe('p');
    expect(snapshot.tree.children[1]?.uid).toBe(`${HERO_FF_REL}:d0.1`);

    socket.terminate();
    await stopAll();
  });

  it('P5 tree-snapshot: an op-driven edit (Inspector set-text) also broadcasts a fresh live tree (self-write-suppressed watcher path is covered explicitly)', async () => {
    await writeFile(HERO_ABS(), HERO_JSX_SOURCE);
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 59960,
      frameServerPortStart: 59970,
      treeSnapshotDebounceMs: 20,
    });

    const { socket, events } = connectAndCollect(daemon.daemonPort);

    await vi.waitFor(
      () => expect(events.some((e) => e.t === 'tree-snapshot')).toBe(true),
      { timeout: 3000, interval: 30 },
    );
    events.length = 0;

    socket.send(
      JSON.stringify({
        kind: 'canvas-op',
        opId: 'settext-1',
        fileFolder: 'demo',
        op: { t: 'set-text', uid: `${HERO_FF_REL}:d0.0`, text: 'Renamed Title' },
      }),
    );

    await vi.waitFor(
      () => expect(events.some((e) => e.t === 'tree-snapshot')).toBe(true),
      { timeout: 3000, interval: 30 },
    );

    // This is the watcher's self-write-suppressed path (the write went
    // through applyOp/FileOpQueue, not a raw external edit) — the
    // tree-snapshot above can ONLY have come from `handleCanvasOp`'s
    // explicit `treeSnapshotStore.scheduleRecompute` call, proving that
    // path is real and not just the watcher's.
    const onDisk = await readFile(HERO_ABS(), 'utf8');
    const snapshot = events.find((e) => e.t === 'tree-snapshot') as Extract<
      DaemonEvent,
      { t: 'tree-snapshot' }
    >;
    expect(snapshot.tree).toEqual(buildTree(onDisk, HERO_FF_REL));
    expect(onDisk).toContain('Renamed Title');

    socket.terminate();
    await stopAll();
  });

  it('P3 write-through: applies insert-node, writes the file atomically, and broadcasts file-changed/hmr-update/uid-remap(file-folder-relative)/op-applied', async () => {
    await writeFile(HERO_ABS(), HERO_JSX_SOURCE);
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 59870,
      frameServerPortStart: 59880,
    });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const events: DaemonEvent[] = [];
    socket.on('message', (data) => events.push(JSON.parse(data.toString())));

    socket.send(
      JSON.stringify({
        kind: 'canvas-op',
        opId: 'ins-1',
        fileFolder: 'demo',
        op: {
          t: 'insert-node',
          parentUid: `${HERO_FF_REL}:d0`,
          index: 0,
          source: { kind: 'element', tag: 'div' },
        },
      }),
    );

    await vi.waitFor(
      () => {
        expect(events).toContainEqual({ t: 'file-changed', file: HERO_PROJECT_REL });
        expect(events).toContainEqual({ t: 'hmr-update', file: HERO_PROJECT_REL });
        const remapEvent = events.find((e) => e.t === 'uid-remap');
        expect(remapEvent).toBeDefined();
        const opApplied = events.find((e) => e.t === 'op-applied');
        expect(opApplied).toBeDefined();
      },
      { timeout: 3000, interval: 30 },
    );

    // uid-remap.file is FILE-FOLDER-relative (ADR-0018 item 5) — NOT
    // project-relative like file-changed/hmr-update above.
    const remapEvent = events.find((e) => e.t === 'uid-remap') as Extract<DaemonEvent, { t: 'uid-remap' }>;
    expect(remapEvent.file).toBe(HERO_FF_REL);
    expect(remapEvent.map[`${HERO_FF_REL}:d0.0`]).toBe(`${HERO_FF_REL}:d0.1`);
    expect(remapEvent.map[`${HERO_FF_REL}:d0.1`]).toBe(`${HERO_FF_REL}:d0.2`);

    const opApplied = events.find((e) => e.t === 'op-applied') as Extract<DaemonEvent, { t: 'op-applied' }>;
    expect(opApplied.opId).toBe('ins-1');
    expect(opApplied.inverse).toEqual([{ t: 'delete-node', uid: `${HERO_FF_REL}:d0.0` }]);

    // Never a redundant SECOND file-changed/hmr-update pair from the fs
    // watcher rediscovering the daemon's own write (self-write
    // suppression) — exactly one of each.
    expect(events.filter((e) => e.t === 'file-changed').length).toBe(1);
    expect(events.filter((e) => e.t === 'hmr-update').length).toBe(1);

    const onDisk = await readFile(HERO_ABS(), 'utf8');
    expect(onDisk).toContain('<div></div>');
    expect(onDisk).toContain('<h1>Title</h1>');

    socket.terminate();
    await stopAll();
  });

  it('P3 ApplyOpError path: a dynamic-target op is rejected with the right reason and the file is left untouched', async () => {
    await writeFile(HERO_ABS(), HERO_JSX_SOURCE);
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 59890,
      frameServerPortStart: 59900,
    });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const pending = nextEvent(socket);
    socket.send(
      JSON.stringify({
        kind: 'canvas-op',
        opId: 'dyn-1',
        fileFolder: 'demo',
        op: { t: 'set-text', uid: `${HERO_FF_REL}:d0.1`, text: 'nope' },
      }),
    );

    const rejected = await pending;
    expect(rejected).toMatchObject({ t: 'op-rejected', opId: 'dyn-1' });
    expect((rejected as { reason: string }).reason).toMatch(/^dynamic-locked:/);
    expect(await readFile(HERO_ABS(), 'utf8')).toBe(HERO_JSX_SOURCE);

    socket.terminate();
    await stopAll();
  });

  it('P3 concurrent-IDE-edit guard: an external write racing a canvas op never silently loses the external edit', async () => {
    await writeFile(HERO_ABS(), HERO_JSX_SOURCE);
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 59910,
      frameServerPortStart: 59920,
    });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const events: DaemonEvent[] = [];
    socket.on('message', (data) => events.push(JSON.parse(data.toString())));

    // The op targets d0.0 (the <h1>); the external edit touches an
    // UNRELATED part of the file (a leading comment) so the two changes
    // are independent — a correct guard preserves BOTH regardless of
    // whether the two writes actually straddled the daemon's read/write
    // window or landed sequentially (both are legitimate outcomes; what
    // must NEVER happen is the external comment vanishing because the
    // daemon wrote from a stale in-memory snapshot).
    const EXTERNAL_MARKER = '// external-ide-edit-marker';
    const externallyEdited = `${EXTERNAL_MARKER}\n${HERO_JSX_SOURCE}`;

    socket.send(
      JSON.stringify({
        kind: 'canvas-op',
        opId: 'race-1',
        fileFolder: 'demo',
        op: { t: 'set-text', uid: `${HERO_FF_REL}:d0.0`, text: 'Updated' },
      }),
    );
    // Race a real external write against the daemon's own read-compute-
    // write window — no code-level hook, a genuine filesystem race (Node
    // dispatches the queued op's fs work asynchronously, so this write
    // can land before, during, or after it depending on real timing).
    await writeFile(HERO_ABS(), externallyEdited);

    await vi.waitFor(
      () => {
        const settled = events.find((e) => e.t === 'op-applied' || e.t === 'op-rejected');
        expect(settled).toBeDefined();
      },
      { timeout: 3000, interval: 30 },
    );

    const onDisk = await readFile(HERO_ABS(), 'utf8');
    const settled = events.find((e) => e.t === 'op-applied' || e.t === 'op-rejected')!;
    if (settled.t === 'op-rejected') {
      // Rejected (guard couldn't safely retry) — the external edit MUST
      // survive completely untouched.
      expect((settled as { reason: string }).reason).toBe('file changed, retry');
      expect(onDisk).toBe(externallyEdited);
    } else {
      // Re-applied on top of the fresh external content — the op's own
      // change AND the external comment both survive; the daemon never
      // silently discarded the external write by writing from a stale
      // pre-race snapshot.
      expect(onDisk).toContain('Updated');
      expect(onDisk).toContain(EXTERNAL_MARKER);
    }

    socket.terminate();
    await stopAll();
  });

  it('P3 undo/redo: undo restores the file byte-identical to before, redo re-applies it', async () => {
    await writeFile(HERO_ABS(), HERO_JSX_SOURCE);
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 59930,
      frameServerPortStart: 59940,
    });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const events: DaemonEvent[] = [];
    socket.on('message', (data) => events.push(JSON.parse(data.toString())));

    function waitForKind(pred: (e: DaemonEvent) => boolean): Promise<DaemonEvent> {
      return vi.waitFor(
        () => {
          const found = events.find(pred);
          expect(found).toBeDefined();
          return found!;
        },
        { timeout: 3000, interval: 30 },
      );
    }

    socket.send(
      JSON.stringify({
        kind: 'canvas-op',
        opId: 'op-1',
        fileFolder: 'demo',
        op: { t: 'set-text', uid: `${HERO_FF_REL}:d0.0`, text: 'Updated' },
      }),
    );
    await waitForKind((e) => e.t === 'op-applied');
    const postImage = await readFile(HERO_ABS(), 'utf8');
    expect(postImage).not.toBe(HERO_JSX_SOURCE);

    socket.send(JSON.stringify({ kind: 'undo', requestId: 'u-1', fileFolder: 'demo' }));
    const undoReply = await waitForKind((e) => (e as { kind?: string }).kind === 'undo-result');
    expect(undoReply).toMatchObject({ kind: 'undo-result', requestId: 'u-1', applied: true });

    const afterUndo = await readFile(HERO_ABS(), 'utf8');
    expect(afterUndo).toBe(HERO_JSX_SOURCE); // byte-identical to the pre-image

    socket.send(JSON.stringify({ kind: 'redo', requestId: 'r-1', fileFolder: 'demo' }));
    const redoReply = await waitForKind((e) => (e as { kind?: string }).kind === 'redo-result');
    expect(redoReply).toMatchObject({ kind: 'redo-result', requestId: 'r-1', applied: true });

    const afterRedo = await readFile(HERO_ABS(), 'utf8');
    expect(afterRedo).toBe(postImage); // byte-identical to the original post-image

    // Undo again (undoes the redo), then a SECOND undo finds an empty stack.
    socket.send(JSON.stringify({ kind: 'undo', requestId: 'u-2', fileFolder: 'demo' }));
    await waitForKind((e) => (e as { kind?: string; requestId?: string }).kind === 'undo-result' && (e as { requestId?: string }).requestId === 'u-2');
    socket.send(JSON.stringify({ kind: 'undo', requestId: 'u-3', fileFolder: 'demo' }));
    const emptyStackReply = await waitForKind(
      (e) => (e as { kind?: string; requestId?: string }).kind === 'undo-result' && (e as { requestId?: string }).requestId === 'u-3',
    );
    expect(emptyStackReply).toEqual({ kind: 'undo-result', requestId: 'u-3', fileFolder: 'demo', applied: false, file: null });

    socket.terminate();
    await stopAll();
  });

  // ---- AUDIT-6 BLOCKER regression: path traversal / arbitrary file write
  // (playbook §5.8). Mirrors the auditor's live-proven probe: a crafted
  // uid whose relPath half escapes the file-folder root, sent as a normal
  // canvas-op over the real control-ws, must be rejected before any
  // read/write — never applied, never written outside the root. The
  // "victim" lives inside THIS test's own temp `projectRoot` (never the
  // real repo's `files/demo`), so there's no residue outside the test's
  // own sandbox even if the fix regressed.
  it('AUDIT-6 BLOCKER regression: a ../../-traversal uid is rejected and the outside file is never created/modified', async () => {
    await writeFile(HERO_ABS(), HERO_JSX_SOURCE);
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 60130,
      frameServerPortStart: 60140,
    });

    // Victim OUTSIDE the 'demo' file-folder root (files/demo) but still
    // inside this test's temp projectRoot — matches the auditor's exact
    // exploit shape (`../../outside-victim/target.tsx`, two levels up from
    // files/demo lands at <projectRoot>/outside-victim/target.tsx).
    const victimDir = join(projectRoot, 'outside-victim');
    const victimAbs = join(victimDir, 'target.tsx');
    await mkdir(victimDir, { recursive: true });
    const victimOriginal = 'export default function Target() { return null; }\n';
    await writeFile(victimAbs, victimOriginal);

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const pending = nextEvent(socket);
    socket.send(
      JSON.stringify({
        kind: 'canvas-op',
        opId: 'traversal-1',
        fileFolder: 'demo',
        op: { t: 'set-text', uid: '../../outside-victim/target.tsx:d0', text: 'HACKED' },
      }),
    );

    const rejected = await pending;
    expect(rejected).toMatchObject({ t: 'op-rejected', opId: 'traversal-1' });
    expect((rejected as { reason: string }).reason).toMatch(/invalid path/i);

    // The victim file is untouched — no traversal write landed.
    expect(await readFile(victimAbs, 'utf8')).toBe(victimOriginal);
    // The legit in-folder file the op's fileFolder actually points at is
    // also untouched (the rejection happened before any read/write).
    expect(await readFile(HERO_ABS(), 'utf8')).toBe(HERO_JSX_SOURCE);

    socket.terminate();
    await stopAll();
  });

  it('AUDIT-6 BLOCKER regression: the disk-search fallback branch (no explicit fileFolder) also refuses a traversal uid', async () => {
    await writeFile(HERO_ABS(), HERO_JSX_SOURCE);
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 60145,
      frameServerPortStart: 60155,
    });

    const victimDir = join(projectRoot, 'outside-victim-2');
    const victimAbs = join(victimDir, 'target.tsx');
    await mkdir(victimDir, { recursive: true });
    const victimOriginal = 'export default function Target() { return null; }\n';
    await writeFile(victimAbs, victimOriginal);

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const pending = nextEvent(socket);
    // No `fileFolder` — forces the disk-search fallback branch of
    // `resolveFileFolderForOp`, which used to trust `existsSync` (checks
    // existence, not containment) rather than `resolveContainedPath`.
    socket.send(
      JSON.stringify({
        kind: 'canvas-op',
        opId: 'traversal-2',
        op: { t: 'set-text', uid: '../../outside-victim-2/target.tsx:d0', text: 'HACKED' },
      }),
    );

    const rejected = await pending;
    expect(rejected).toMatchObject({ t: 'op-rejected', opId: 'traversal-2' });
    expect(await readFile(victimAbs, 'utf8')).toBe(victimOriginal);

    socket.terminate();
    await stopAll();
  });

  it('AUDIT-6 BLOCKER regression: an absolute-path uid is rejected, not resolved against the real filesystem root', async () => {
    await writeFile(HERO_ABS(), HERO_JSX_SOURCE);
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 60150,
      frameServerPortStart: 60160,
    });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const pending = nextEvent(socket);
    socket.send(
      JSON.stringify({
        kind: 'canvas-op',
        opId: 'abs-1',
        fileFolder: 'demo',
        op: { t: 'set-text', uid: '/etc/hosts.tsx:d0', text: 'HACKED' },
      }),
    );

    const rejected = await pending;
    expect(rejected).toMatchObject({ t: 'op-rejected', opId: 'abs-1' });
    expect((rejected as { reason: string }).reason).toMatch(/invalid path/i);

    socket.terminate();
    await stopAll();
  });

  it('AUDIT-6 regression sanity: a legit in-folder uid still applies normally after the containment fix', async () => {
    await writeFile(HERO_ABS(), HERO_JSX_SOURCE);
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 60170,
      frameServerPortStart: 60180,
    });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const events: DaemonEvent[] = [];
    socket.on('message', (data) => events.push(JSON.parse(data.toString())));
    socket.send(
      JSON.stringify({
        kind: 'canvas-op',
        opId: 'legit-1',
        fileFolder: 'demo',
        op: { t: 'set-text', uid: `${HERO_FF_REL}:d0.0`, text: 'Still Works' },
      }),
    );

    await vi.waitFor(
      () => {
        expect(events).toContainEqual(expect.objectContaining({ t: 'op-applied', opId: 'legit-1' }));
      },
      { timeout: 3000, interval: 30 },
    );
    expect(await readFile(HERO_ABS(), 'utf8')).toContain('Still Works');

    socket.terminate();
    await stopAll();
  });

  it('P3 git checkpoint: after the N-ops threshold a "studio: " commit lands in the file-folder\'s own nested repo', async () => {
    await writeFile(HERO_ABS(), HERO_JSX_SOURCE);
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 59950,
      frameServerPortStart: 59960,
      checkpointEveryNOps: 1,
      checkpointIdleMs: 60_000,
    });

    const demoRoot = join(projectRoot, 'files', 'demo');
    // A repo already exists at project-open (ensureFileFolderGitRepo runs
    // for every file-folder up front) — assert that too.
    expect(await simpleGit(demoRoot).checkIsRepo()).toBe(true);

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const opApplied = nextEvent(socket);
    socket.send(
      JSON.stringify({
        kind: 'canvas-op',
        opId: 'ckpt-1',
        fileFolder: 'demo',
        op: { t: 'set-text', uid: `${HERO_FF_REL}:d0.0`, text: 'Checkpointed' },
      }),
    );
    await opApplied;

    const log = await vi.waitFor(
      async () => {
        const l = await simpleGit(demoRoot).log();
        expect(l.total).toBeGreaterThanOrEqual(1);
        return l;
      },
      { timeout: 5000, interval: 50 },
    );
    expect(log.latest?.message).toMatch(/^studio: /);

    // node_modules/.studio are kept out of the checkpoint (task brief).
    const tracked = await simpleGit(demoRoot).raw(['ls-tree', '-r', '--name-only', 'HEAD']);
    expect(tracked).not.toMatch(/node_modules/);
    expect(tracked).not.toMatch(/^\.studio\//m);

    socket.terminate();
    await stopAll();
  });

  it('serializes ops targeting the same file (per-file queue) in arrival order', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 59850,
      frameServerPortStart: 59860,
    });

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
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 59870,
      frameServerPortStart: 59880,
    });

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
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 59910,
      frameServerPortStart: 59920,
    });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const received: DaemonEvent[] = [];
    socket.on('message', (data) => received.push(JSON.parse(data.toString())));

    socket.send(
      JSON.stringify({
        kind: 'create-frame',
        requestId: 'req-1',
        fileFolder: 'demo',
        name: 'Testimonials',
      }),
    );

    await vi.waitFor(
      () => {
        expect(received).toContainEqual({
          t: 'file-changed',
          file: 'files/demo/src/frames/Testimonials.tsx',
        });
        expect(received).toContainEqual({
          t: 'file-changed',
          file: 'files/demo/.studio/canvas.json',
        });
      },
      { timeout: 3000, interval: 30 },
    );

    const tsxContent = await readFile(
      join(projectRoot, 'files', 'demo', 'src', 'frames', 'Testimonials.tsx'),
      'utf8',
    );
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
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 59930,
      frameServerPortStart: 59940,
    });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const pending = nextEvent(socket);
    socket.send(
      JSON.stringify({
        kind: 'create-frame',
        requestId: 'req-2',
        fileFolder: 'demo',
        name: '../../etc/passwd',
      }),
    );

    const reply = await pending;
    expect(reply).toMatchObject({ kind: 'control-error', requestId: 'req-2' });
    expect((reply as { reason: string }).reason).toMatch(/invalid frame name/);

    socket.terminate();
    await stopAll();
  });

  it('ADR-0014: create-frame rejects a duplicate frame name', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 59950,
      frameServerPortStart: 59960,
    });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    socket.send(
      JSON.stringify({ kind: 'create-frame', requestId: 'req-a', fileFolder: 'demo', name: 'Dup' }),
    );
    await vi.waitFor(async () => {
      const meta = await readCanvasJson(join(projectRoot, 'files', 'demo'));
      expect(meta.frames.some((f) => f.framePath === 'src/frames/Dup.tsx')).toBe(true);
    });

    const pending = nextEvent(socket);
    socket.send(
      JSON.stringify({ kind: 'create-frame', requestId: 'req-b', fileFolder: 'demo', name: 'Dup' }),
    );
    const reply = await pending;
    expect(reply).toMatchObject({ kind: 'control-error', requestId: 'req-b' });

    socket.terminate();
    await stopAll();
  });

  it('ADR-0014: create-frame rejects an unknown file-folder', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 59970,
      frameServerPortStart: 59980,
    });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const pending = nextEvent(socket);
    socket.send(
      JSON.stringify({
        kind: 'create-frame',
        requestId: 'req-3',
        fileFolder: 'nonexistent',
        name: 'X',
      }),
    );

    const reply = await pending;
    expect(reply).toMatchObject({ kind: 'control-error', requestId: 'req-3' });
    expect((reply as { reason: string }).reason).toMatch(/unknown file-folder/);

    socket.terminate();
    await stopAll();
  });

  it('ADR-0014: get-canvas-json round-trips the current FrameMeta for a file-folder', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 59990,
      frameServerPortStart: 60000,
    });

    const onDisk = await readCanvasJson(join(projectRoot, 'files', 'demo'));

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const pending = nextEvent(socket);
    socket.send(
      JSON.stringify({ kind: 'get-canvas-json', requestId: 'req-4', fileFolder: 'demo' }),
    );

    const reply = await pending;
    expect(reply).toEqual({
      kind: 'get-canvas-json-result',
      requestId: 'req-4',
      fileFolder: 'demo',
      meta: onDisk,
    });

    socket.terminate();
    await stopAll();
  });

  it('ADR-0014: get-canvas-json reflects a create-frame that was queued just before it (per-file-folder ordering)', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 60010,
      frameServerPortStart: 60020,
    });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const received: unknown[] = [];
    socket.on('message', (data) => received.push(JSON.parse(data.toString())));

    // create-frame's own two file-changed broadcasts land on this same
    // socket ahead of the get-canvas-json-result reply (both requests are
    // queued on the same file-folder key, in arrival order) — so this
    // waits for the specific reply by shape rather than "the next message".
    socket.send(
      JSON.stringify({
        kind: 'create-frame',
        requestId: 'req-c',
        fileFolder: 'demo',
        name: 'QueueOrder',
      }),
    );
    socket.send(
      JSON.stringify({ kind: 'get-canvas-json', requestId: 'req-d', fileFolder: 'demo' }),
    );

    await vi.waitFor(() => {
      expect(received).toContainEqual(
        expect.objectContaining({ kind: 'get-canvas-json-result', requestId: 'req-d' }),
      );
    });

    const reply = received.find(
      (m): m is { kind: string; meta?: { frames: Array<{ framePath: string }> } } =>
        typeof m === 'object' &&
        m !== null &&
        (m as { kind?: unknown }).kind === 'get-canvas-json-result',
    );
    expect(reply?.meta?.frames.some((f) => f.framePath === 'src/frames/QueueOrder.tsx')).toBe(true);

    socket.terminate();
    await stopAll();
  });

  it('ADR-0015: duplicate-frame copies the source content, patches the registry, and appends a +40/+40 canvas.json entry', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 60030,
      frameServerPortStart: 60040,
    });

    const before = await readCanvasJson(join(projectRoot, 'files', 'demo'));
    const heroBefore = before.frames.find((f) => f.framePath === 'src/frames/Hero.tsx');
    expect(heroBefore).toBeDefined();

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const received: DaemonEvent[] = [];
    socket.on('message', (data) => received.push(JSON.parse(data.toString())));

    socket.send(
      JSON.stringify({
        kind: 'duplicate-frame',
        requestId: 'req-5',
        fileFolder: 'demo',
        sourceName: 'Hero',
      }),
    );

    await vi.waitFor(
      () => {
        expect(received).toContainEqual({
          t: 'file-changed',
          file: 'files/demo/src/frames/HeroCopy.tsx',
        });
        expect(received).toContainEqual({
          t: 'file-changed',
          file: 'files/demo/.studio/canvas.json',
        });
      },
      { timeout: 3000, interval: 30 },
    );

    const sourceContent = await readFile(
      join(projectRoot, 'files', 'demo', 'src', 'frames', 'Hero.tsx'),
      'utf8',
    );
    const copiedContent = await readFile(
      join(projectRoot, 'files', 'demo', 'src', 'frames', 'HeroCopy.tsx'),
      'utf8',
    );
    expect(copiedContent).toBe(sourceContent);

    const registry = await readFile(join(projectRoot, 'files', 'demo', 'src', 'frames.ts'), 'utf8');
    expect(registry).toContain("import HeroCopy from './frames/HeroCopy.js';");

    const meta = await readCanvasJson(join(projectRoot, 'files', 'demo'));
    const copyEntry = meta.frames.find((f) => f.framePath === 'src/frames/HeroCopy.tsx');
    expect(copyEntry).toEqual({
      framePath: 'src/frames/HeroCopy.tsx',
      x: heroBefore!.x + 40,
      y: heroBefore!.y + 40,
      w: heroBefore!.w,
      h: heroBefore!.h,
    });

    socket.terminate();
    await stopAll();
  });

  it('ADR-0015: duplicate-frame replies with a dedicated duplicate-frame-result carrying the picked newName', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 60050,
      frameServerPortStart: 60060,
    });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    // The two `file-changed` broadcasts land on this same socket ahead of
    // the direct `duplicate-frame-result` reply (broadcast happens before
    // `reply()` in `handleDuplicateFrame` — same ordering `create-frame`
    // uses), so collect every message rather than assuming the reply is
    // the first one, mirroring the "queue order" test below.
    const received: unknown[] = [];
    socket.on('message', (data) => received.push(JSON.parse(data.toString())));

    socket.send(
      JSON.stringify({
        kind: 'duplicate-frame',
        requestId: 'req-6',
        fileFolder: 'demo',
        sourceName: 'Pricing',
      }),
    );

    await vi.waitFor(() => {
      expect(received).toContainEqual({
        kind: 'duplicate-frame-result',
        requestId: 'req-6',
        fileFolder: 'demo',
        sourceName: 'Pricing',
        newName: 'PricingCopy',
        framePath: 'src/frames/PricingCopy.tsx',
      });
    });

    socket.terminate();
    await stopAll();
  });

  it('ADR-0015: duplicate-frame rejects an unknown source frame with a direct control-error reply (no broadcast)', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 60070,
      frameServerPortStart: 60080,
    });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const pending = nextEvent(socket);
    socket.send(
      JSON.stringify({
        kind: 'duplicate-frame',
        requestId: 'req-7',
        fileFolder: 'demo',
        sourceName: 'Ghost',
      }),
    );

    const reply = await pending;
    expect(reply).toMatchObject({ kind: 'control-error', requestId: 'req-7' });
    expect((reply as { reason: string }).reason).toMatch(/unknown source frame/);

    socket.terminate();
    await stopAll();
  });

  it('ADR-0015: duplicate-frame rejects an unknown file-folder', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 60090,
      frameServerPortStart: 60100,
    });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const pending = nextEvent(socket);
    socket.send(
      JSON.stringify({
        kind: 'duplicate-frame',
        requestId: 'req-8',
        fileFolder: 'nonexistent',
        sourceName: 'Hero',
      }),
    );

    const reply = await pending;
    expect(reply).toMatchObject({ kind: 'control-error', requestId: 'req-8' });
    expect((reply as { reason: string }).reason).toMatch(/unknown file-folder/);

    socket.terminate();
    await stopAll();
  });

  it('ADR-0015: duplicate-frame queued right after create-frame observes the create (per-file-folder ordering)', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 60110,
      frameServerPortStart: 60120,
    });

    const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
    const received: unknown[] = [];
    socket.on('message', (data) => received.push(JSON.parse(data.toString())));

    socket.send(
      JSON.stringify({
        kind: 'create-frame',
        requestId: 'req-9',
        fileFolder: 'demo',
        name: 'Fresh',
      }),
    );
    socket.send(
      JSON.stringify({
        kind: 'duplicate-frame',
        requestId: 'req-10',
        fileFolder: 'demo',
        sourceName: 'Fresh',
      }),
    );

    await vi.waitFor(() => {
      const dupReply = received.find(
        (m) =>
          typeof m === 'object' &&
          m !== null &&
          (m as { kind?: unknown }).kind === 'duplicate-frame-result',
      );
      expect(dupReply).toMatchObject({
        kind: 'duplicate-frame-result',
        requestId: 'req-10',
        newName: 'FreshCopy',
      });
    });

    socket.terminate();
    await stopAll();
  });

  // ---- FP-INS-b: read-source (Inspect tab "Code (JSX)" section) ---------
  // Additive, READ-ONLY control message. The security-critical assertions
  // here mirror the AUDIT-6/6b regression tests above almost verbatim
  // (same shared `resolveContainedPath` gate, same proven exploit shapes) —
  // this is deliberately treated as seriously as the write path, per this
  // task's brief ("the auditor WILL re-attack this like AUDIT-6 did the
  // write path").

  describe('FP-INS-b: read-source', () => {
    it('reads the WHOLE FRAME source verbatim when no uid is given', async () => {
      await writeFile(HERO_ABS(), HERO_JSX_SOURCE);
      const { startVite, stopAll } = makeFakeStartVite();
      daemon = await openProject({ projectRoot, startVite, daemonPortStart: 60500, frameServerPortStart: 60510 });

      const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
      const pending = nextEvent(socket);
      socket.send(
        JSON.stringify({ kind: 'read-source', requestId: 'rs-1', fileFolder: 'demo', framePath: HERO_FF_REL }),
      );

      const reply = await pending;
      expect(reply).toEqual({
        kind: 'read-source-result',
        requestId: 'rs-1',
        fileFolder: 'demo',
        framePath: HERO_FF_REL,
        uid: null,
        source: HERO_JSX_SOURCE,
      });

      socket.terminate();
      await stopAll();
    });

    it('reads exactly one NODE\'s JSX slice when a uid is given (reprinted from the parsed AST, not a substring-hack)', async () => {
      await writeFile(HERO_ABS(), HERO_JSX_SOURCE);
      const { startVite, stopAll } = makeFakeStartVite();
      daemon = await openProject({ projectRoot, startVite, daemonPortStart: 60520, frameServerPortStart: 60530 });

      const tree = buildTree(HERO_JSX_SOURCE, HERO_FF_REL);
      const h1Uid = tree.children[0]!.uid; // the <h1>Title</h1> node
      expect(h1Uid).toContain(HERO_FF_REL);

      const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
      const pending = nextEvent(socket);
      socket.send(
        JSON.stringify({
          kind: 'read-source',
          requestId: 'rs-2',
          fileFolder: 'demo',
          framePath: HERO_FF_REL,
          uid: h1Uid,
        }),
      );

      const reply = await pending;
      expect(reply).toEqual({
        kind: 'read-source-result',
        requestId: 'rs-2',
        fileFolder: 'demo',
        framePath: HERO_FF_REL,
        uid: h1Uid,
        source: '<h1>Title</h1>',
      });

      socket.terminate();
      await stopAll();
    });

    it('rejects an unknown file-folder with a direct control-error (no fs access attempted)', async () => {
      await writeFile(HERO_ABS(), HERO_JSX_SOURCE);
      const { startVite, stopAll } = makeFakeStartVite();
      daemon = await openProject({ projectRoot, startVite, daemonPortStart: 60540, frameServerPortStart: 60550 });

      const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
      const pending = nextEvent(socket);
      socket.send(
        JSON.stringify({ kind: 'read-source', requestId: 'rs-3', fileFolder: 'not-a-real-folder', framePath: HERO_FF_REL }),
      );

      const reply = await pending;
      expect(reply).toMatchObject({ kind: 'control-error', requestId: 'rs-3' });
      expect((reply as { reason: string }).reason).toMatch(/unknown file-folder/);

      socket.terminate();
      await stopAll();
    });

    it('SECURITY (containment-rejection, traversal): a ../../-traversal framePath is rejected, never read', async () => {
      await writeFile(HERO_ABS(), HERO_JSX_SOURCE);
      const { startVite, stopAll } = makeFakeStartVite();
      daemon = await openProject({ projectRoot, startVite, daemonPortStart: 60560, frameServerPortStart: 60570 });

      // A secret file OUTSIDE the 'demo' file-folder root but still inside
      // this test's temp projectRoot — same exploit shape AUDIT-6 proved
      // against the write path, replayed here against the read path.
      const victimDir = join(projectRoot, 'outside-victim-read');
      const victimAbs = join(victimDir, 'secret.tsx');
      await mkdir(victimDir, { recursive: true });
      const victimContent = 'export const SECRET = "should never be exposed";\n';
      await writeFile(victimAbs, victimContent);

      const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
      const pending = nextEvent(socket);
      socket.send(
        JSON.stringify({
          kind: 'read-source',
          requestId: 'rs-4',
          fileFolder: 'demo',
          framePath: '../../outside-victim-read/secret.tsx',
        }),
      );

      const reply = await pending;
      expect(reply).toMatchObject({ kind: 'control-error', requestId: 'rs-4' });
      expect((reply as { reason: string }).reason).toMatch(/invalid path/i);
      // The reply must NEVER carry the victim file's content.
      expect(JSON.stringify(reply)).not.toContain('SECRET');

      socket.terminate();
      await stopAll();
    });

    it('SECURITY (containment-rejection, absolute path): an absolute framePath is rejected, not resolved against the real fs root', async () => {
      await writeFile(HERO_ABS(), HERO_JSX_SOURCE);
      const { startVite, stopAll } = makeFakeStartVite();
      daemon = await openProject({ projectRoot, startVite, daemonPortStart: 60580, frameServerPortStart: 60590 });

      const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
      const pending = nextEvent(socket);
      socket.send(
        JSON.stringify({
          kind: 'read-source',
          requestId: 'rs-5',
          fileFolder: 'demo',
          framePath: process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd',
        }),
      );

      const reply = await pending;
      expect(reply).toMatchObject({ kind: 'control-error', requestId: 'rs-5' });

      socket.terminate();
      await stopAll();
    });

    it('SECURITY (containment-rejection, symlink escape — AUDIT-6b shape): a framePath addressed THROUGH a pre-existing symlink pointing outside the root is rejected, never read', async () => {
      const { startVite, stopAll } = makeFakeStartVite();
      daemon = await openProject({ projectRoot, startVite, daemonPortStart: 60600, frameServerPortStart: 60610 });

      const outsideDir = await mkdtemp(join(tmpdir(), 'ccs-read-source-outside-'));
      const victimContent = 'export const SECRET = "symlink-escape should never be exposed";\n';
      await writeFile(join(outsideDir, 'secret.tsx'), victimContent);

      const demoRoot = join(projectRoot, 'files', 'demo');
      const symlinkPath = join(demoRoot, 'src', 'frames', 'shortcut');
      let symlinkCreated = false;
      try {
        await symlink(outsideDir, symlinkPath, 'dir');
        symlinkCreated = true;
      } catch (err) {
        // Symlink creation can require elevated privileges on some Windows
        // configurations (no Developer Mode / no admin) — if the symlink
        // itself can't even be created, there's nothing to escape through;
        // skip this one assertion rather than false-failing on an
        // environment limitation unrelated to the containment logic itself
        // (the lexical/absolute-path/unknown-file-folder cases above still
        // fully cover this handler on every platform).
        console.warn('[read-source symlink test] skipped: could not create symlink —', err);
      }

      if (symlinkCreated) {
        try {
          const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
          const pending = nextEvent(socket);
          socket.send(
            JSON.stringify({
              kind: 'read-source',
              requestId: 'rs-6',
              fileFolder: 'demo',
              framePath: 'src/frames/shortcut/secret.tsx',
            }),
          );

          const reply = await pending;
          expect(reply).toMatchObject({ kind: 'control-error', requestId: 'rs-6' });
          expect((reply as { reason: string }).reason).toMatch(/escapes the file-folder root/i);
          expect(JSON.stringify(reply)).not.toContain('SECRET');

          socket.terminate();
        } finally {
          await rm(symlinkPath, { force: true });
        }
      }

      await stopAll();
      await rm(outsideDir, { recursive: true, force: true });
    });

    it('reports a clear error (not a crash) when the uid does not resolve to any node in the current source', async () => {
      await writeFile(HERO_ABS(), HERO_JSX_SOURCE);
      const { startVite, stopAll } = makeFakeStartVite();
      daemon = await openProject({ projectRoot, startVite, daemonPortStart: 60620, frameServerPortStart: 60630 });

      const { socket } = await connectAndGetBootstrap(daemon.daemonPort);
      const pending = nextEvent(socket);
      socket.send(
        JSON.stringify({
          kind: 'read-source',
          requestId: 'rs-7',
          fileFolder: 'demo',
          framePath: HERO_FF_REL,
          uid: `${HERO_FF_REL}:d0.99`,
        }),
      );

      const reply = await pending;
      expect(reply).toMatchObject({ kind: 'control-error', requestId: 'rs-7' });
      expect((reply as { reason: string }).reason).toMatch(/no JSX node found/);

      socket.terminate();
      await stopAll();
    });
  });

  it('close() stops watchers/servers so a second openProject can reuse the same ports', async () => {
    const { startVite, stopAll } = makeFakeStartVite();
    const first = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 59890,
      frameServerPortStart: 59900,
    });
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

  it('studioMode: false (default) boots every file-folder with no studioConfigPath (P0 standalone contract preserved)', async () => {
    const { startVite, stopAll, calls } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      daemonPortStart: 59955,
      frameServerPortStart: 59965,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.studioConfigPath).toBeUndefined();

    await stopAll();
  });

  it('studioMode: true generates a per-file-folder studio Vite config and passes it through to startVite (ADR-0016 addendum)', async () => {
    const { startVite, stopAll, calls } = makeFakeStartVite();
    daemon = await openProject({
      projectRoot,
      startVite,
      studioMode: true,
      daemonPortStart: 59956,
      frameServerPortStart: 59966,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.studioConfigPath).toBeDefined();
    expect(calls[0]!.studioConfigPath).toBe(
      join(projectRoot, '.studio', 'vite', 'demo.studio-config.mjs'),
    );

    const generated = await readFile(calls[0]!.studioConfigPath!, 'utf8');
    expect(generated).toContain('sourceUidPlugin');
    expect(generated).toContain('installBridge');

    await stopAll();
  });
});
