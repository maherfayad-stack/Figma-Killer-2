/**
 * Dev-only create-frame HTTP endpoint (playbook §4/P1 step 4). See
 * `run-daemon.ts`'s module doc for why this exists instead of a daemon
 * API (CHANGE-REQUEST in the P1 report). Factored out of `run-daemon.ts`
 * so both the manual demo (`run-daemon.ts`) and the automated Playwright
 * e2e (`e2e/tests/acceptance.spec.ts`) start the exact same endpoint
 * against their own real `DaemonHandle` — the e2e suite boots its own
 * `openProject()` on different ports (so it can run independently of a
 * manually-running demo), and needs this same create-frame wiring to
 * exercise the "+ New Frame" UI for real.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readCanvasJson, writeCanvasJsonAtomic, type DaemonHandle } from '@ccs/sync-daemon';
import {
  buildFrameSource,
  buildNewCanvasJsonEntry,
  frameSourcePath,
  isValidFrameName,
  patchFramesRegistry,
} from '../src/new-frame.js';

export const CREATE_FRAME_HTTP_PORT = 4799;

export async function createFrameOnDisk(daemon: DaemonHandle, fileFolder: string, name: string): Promise<void> {
  if (!isValidFrameName(name)) {
    throw new Error(`invalid frame name "${name}" — must be PascalCase (e.g. "Testimonials")`);
  }
  const folder = daemon.fileFolders.find((f) => f.name === fileFolder);
  if (!folder) throw new Error(`unknown file-folder "${fileFolder}"`);

  const relPath = frameSourcePath(name);
  const absSourcePath = join(folder.root, relPath);
  const framesRegistryPath = join(folder.root, 'src', 'frames.ts');

  const registrySource = await readFile(framesRegistryPath, 'utf8');
  const patchedRegistry = patchFramesRegistry(registrySource, name); // throws if already registered

  const meta = await readCanvasJson(folder.root);
  const newEntry = buildNewCanvasJsonEntry(meta.frames, name);

  // Write the source file first, then the registry, then canvas.json last
  // — canvas.json's `file-changed` is what the client treats as
  // authoritative for geometry, so it should land after the frame is
  // actually renderable.
  await writeFile(absSourcePath, buildFrameSource(name), 'utf8');
  await writeFile(framesRegistryPath, patchedRegistry, 'utf8');
  await writeCanvasJsonAtomic(folder.root, { ...meta, frames: [...meta.frames, newEntry] });
}

function withCors(res: ServerResponse): void {
  // Dev-harness-only, loopback-bound (see module doc) — permissive CORS
  // is fine here the same way the control-ws being localhost-only is the
  // actual security boundary (playbook §5.8), not this endpoint's CORS
  // policy.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export function startCreateFrameServer(daemon: DaemonHandle, port: number = CREATE_FRAME_HTTP_PORT): Server {
  const server = createServer((req, res) => {
    withCors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    if (req.method !== 'POST' || req.url !== '/create-frame') {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
      return;
    }
    void readBody(req)
      .then(async (raw) => {
        const { fileFolder, name } = JSON.parse(raw) as { fileFolder?: string; name?: string };
        if (!fileFolder || !name) throw new Error('body must be {fileFolder, name}');
        await createFrameOnDisk(daemon, fileFolder, name);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
        console.log(`[create-frame] created "${name}" in file-folder "${fileFolder}"`);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[create-frame] failed: ${message}`);
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: message }));
      });
  });
  server.listen(port, '127.0.0.1');
  return server;
}
