import { readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DaemonEvent } from '@ccs/protocol';
import { openProject, type DaemonHandle } from './daemon.js';
import { readCanvasJson } from './canvas-json.js';

/**
 * ============================================================================
 * RUNNABLE EVIDENCE SCRIPT for the P1 sync-daemon sub-acceptance criteria.
 *
 * Run it directly with:
 *   pnpm --filter @ccs/sync-daemon exec vitest run src/e2e.demo.test.ts
 * (it is also part of the regular `pnpm test` run — see the report for why
 * that's a deliberate choice: the exact same assertions are both "tests"
 * and "the demo").
 *
 * Drives a REAL daemon (real `vite` dev servers, real chokidar watchers,
 * real localhost-only control ws) against the repo's own `files/demo`
 * fixture (created by `pnpm create-file demo`; already has 2 frames, one
 * of which — Pricing.tsx — is the Arabic/RTL content fixture, playbook
 * §5.9). Every mutation this file makes to `files/demo` is reverted in
 * `afterAll` so the fixture is left exactly as it started.
 *
 * Evidence produced (see console output), one item per playbook
 * sub-acceptance requirement:
 *   (a) each file-folder's Vite server serves ?frame=<Name> → 200
 *   (b) editing a frame .tsx on disk → hmr-update/file-changed DaemonEvent
 *   (c) adding/removing a frame file → file-changed DaemonEvent
 *   (d) a geometry-write call updates .studio/canvas.json (before/after,
 *       still FrameMeta-valid)
 *   (e) the control ws refuses a non-loopback connection
 * ============================================================================
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PROJECT_ROOT = REPO_ROOT; // files/ lives at the repo root in this monorepo
const DEMO_ROOT = join(PROJECT_ROOT, 'files', 'demo');
const HERO_TSX = join(DEMO_ROOT, 'src', 'frames', 'Hero.tsx');
const TEMP_FRAME_TSX = join(DEMO_ROOT, 'src', 'frames', 'TempDemoFrame.tsx');

function connectAndConsumeBootstrap(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once('message', () => resolve(socket)); // first message = bootstrap; consumed, discarded here
    socket.once('error', reject);
  });
}

function waitForEvent(
  socket: WebSocket,
  predicate: (e: DaemonEvent) => boolean,
  timeoutMs = 8000,
): Promise<DaemonEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`timed out after ${timeoutMs}ms waiting for a matching DaemonEvent`));
    }, timeoutMs);
    function onMessage(data: Buffer) {
      const event = JSON.parse(data.toString()) as DaemonEvent;
      if (predicate(event)) {
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve(event);
      }
    }
    socket.on('message', onMessage);
  });
}

function attemptNonLoopbackConnect(host: string, port: number): Promise<'refused' | 'connected'> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 1500 });
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('error', () => resolve('refused'));
    socket.once('timeout', () => {
      socket.destroy();
      resolve('refused');
    });
  });
}

function firstNonLoopbackIPv4(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

describe('sync-daemon P1 — end-to-end demo evidence (files/demo fixture)', () => {
  let daemon: DaemonHandle;
  let originalHeroSource: string;
  let originalCanvasJsonRaw: string;

  beforeAll(async () => {
    originalHeroSource = await readFile(HERO_TSX, 'utf8');
    originalCanvasJsonRaw = await readFile(join(DEMO_ROOT, '.studio', 'canvas.json'), 'utf8');

    daemon = await openProject({
      projectRoot: PROJECT_ROOT,
      daemonPortStart: 4700,
      frameServerPortStart: 5200,
    });

    console.log(`\n[demo] daemon started — control ws on 127.0.0.1:${daemon.daemonPort}`);
    for (const ff of daemon.fileFolders) {
      console.log(`[demo] file-folder "${ff.name}" → vite dev server ${ff.devServerUrl} (frames: ${ff.frameNames.join(', ')})`);
    }
  }, 30_000);

  afterAll(async () => {
    await rm(TEMP_FRAME_TSX, { force: true });
    await writeFile(HERO_TSX, originalHeroSource);
    await writeFile(join(DEMO_ROOT, '.studio', 'canvas.json'), originalCanvasJsonRaw);
    await daemon.close();
    console.log('[demo] daemon closed, files/demo fixture restored to its original state');
  }, 15_000);

  it(
    '(a) each frame is served at ?frame=<Name> with a 200 — curl-equivalent evidence',
    async () => {
      const demoFolder = daemon.fileFolders.find((f) => f.name === 'demo');
      expect(demoFolder).toBeDefined();
      const base = demoFolder!.devServerUrl;

      for (const frameName of ['Hero', 'Pricing']) {
        const res = await fetch(`${base}/?frame=${frameName}`);
        console.log(`[demo] (a) GET ${base}/?frame=${frameName} -> ${res.status}`);
        expect(res.status).toBe(200);
      }
    },
    15_000,
  );

  it(
    '(b) editing Hero.tsx on disk emits hmr-update + file-changed over the control ws',
    async () => {
      const socket = await connectAndConsumeBootstrap(daemon.daemonPort);

      const hmrPending = waitForEvent(
        socket,
        (e) => e.t === 'hmr-update' && e.file === 'files/demo/src/frames/Hero.tsx',
      );
      const fileChangedPending = waitForEvent(
        socket,
        (e) => e.t === 'file-changed' && e.file === 'files/demo/src/frames/Hero.tsx',
      );

      await writeFile(HERO_TSX, originalHeroSource.replace('Plan your next trip', 'Plan your NEXT trip'));

      const [hmr, fileChanged] = await Promise.all([hmrPending, fileChangedPending]);
      console.log('[demo] (b) received DaemonEvent:', JSON.stringify(hmr));
      console.log('[demo] (b) received DaemonEvent:', JSON.stringify(fileChanged));

      expect(hmr).toEqual({ t: 'hmr-update', file: 'files/demo/src/frames/Hero.tsx' });
      expect(fileChanged).toEqual({ t: 'file-changed', file: 'files/demo/src/frames/Hero.tsx' });

      socket.terminate();
    },
    15_000,
  );

  it(
    '(c) adding then removing a frame file emits file-changed for each transition',
    async () => {
      const socket = await connectAndConsumeBootstrap(daemon.daemonPort);

      const addPending = waitForEvent(
        socket,
        (e) => e.t === 'file-changed' && e.file === 'files/demo/src/frames/TempDemoFrame.tsx',
      );
      await writeFile(TEMP_FRAME_TSX, 'export default function TempDemoFrame() { return null; }\n');
      const added = await addPending;
      console.log('[demo] (c) frame added ->', JSON.stringify(added));
      expect(added).toEqual({ t: 'file-changed', file: 'files/demo/src/frames/TempDemoFrame.tsx' });

      // Give chokidar's initial-scan settle a beat so the just-added file
      // is tracked before we remove it (same discipline as watcher.test.ts).
      await new Promise((resolve) => setTimeout(resolve, 300));

      const removePending = waitForEvent(
        socket,
        (e) => e.t === 'file-changed' && e.file === 'files/demo/src/frames/TempDemoFrame.tsx',
      );
      await rm(TEMP_FRAME_TSX);
      const removed = await removePending;
      console.log('[demo] (c) frame removed ->', JSON.stringify(removed));
      expect(removed).toEqual({ t: 'file-changed', file: 'files/demo/src/frames/TempDemoFrame.tsx' });

      socket.terminate();
    },
    15_000,
  );

  it(
    '(d) a geometry write updates .studio/canvas.json atomically, staying FrameMeta-valid',
    async () => {
      const before = await readCanvasJson(DEMO_ROOT);
      console.log('[demo] (d) canvas.json BEFORE:', JSON.stringify(before));

      await daemon.writeGeometry('demo', 'src/frames/Hero.tsx', { x: 321, y: 654, w: 1000, h: 700 });

      const after = await readCanvasJson(DEMO_ROOT); // readCanvasJson itself throws if invalid FrameMeta
      console.log('[demo] (d) canvas.json AFTER: ', JSON.stringify(after));

      const heroBefore = before.frames.find((f) => f.framePath === 'src/frames/Hero.tsx');
      const heroAfter = after.frames.find((f) => f.framePath === 'src/frames/Hero.tsx');
      expect(heroAfter).toEqual({ framePath: 'src/frames/Hero.tsx', x: 321, y: 654, w: 1000, h: 700 });
      expect(heroAfter).not.toEqual(heroBefore);
      // Pricing entry must be untouched by a write scoped to Hero.
      expect(after.frames.find((f) => f.framePath === 'src/frames/Pricing.tsx')).toEqual(
        before.frames.find((f) => f.framePath === 'src/frames/Pricing.tsx'),
      );
    },
    10_000,
  );

  it(
    '(e) the control ws refuses a connection from a non-loopback address',
    async () => {
      const nonLoopback = firstNonLoopbackIPv4();
      console.log('[demo] (e) control ws bound host: 127.0.0.1 (loopback-only by construction)');
      if (!nonLoopback) {
        console.log('[demo] (e) sandbox has no non-loopback IPv4 interface — skipping the live refusal probe');
        return;
      }
      const result = await attemptNonLoopbackConnect(nonLoopback, daemon.daemonPort);
      console.log(`[demo] (e) TCP connect to ${nonLoopback}:${daemon.daemonPort} -> ${result}`);
      expect(result).toBe('refused');
    },
    10_000,
  );
});
