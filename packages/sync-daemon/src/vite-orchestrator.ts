import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One Vite dev server per file-folder — NOT per frame (playbook §4/P1 step
 * 2 + §4/P1 pitfall). Frames within a file-folder share the one server and
 * are addressed via `?frame=<Name>` (App.tsx's frame router, from
 * `templates/file-app`). HMR connects directly from the browser/iframe to
 * this server — the daemon never proxies the HMR websocket (ADR-0012,
 * same pitfall).
 */

export interface ViteServerHandle {
  port: number;
  host: string;
  pid: number;
  /** Base URL, no query string, e.g. "http://127.0.0.1:5200". */
  url: string;
  readonly process: ChildProcess;
  stop(): Promise<void>;
}

export interface StartViteServerOptions {
  /** Absolute path to the file-folder root (Vite's cwd/root). */
  cwd: string;
  port: number;
  host?: string;
  /** How long to wait for the dev server to start responding before
   * giving up. */
  readyTimeoutMs?: number;
}

/**
 * Boot a real Vite dev server for one file-folder. Prefers the
 * file-folder's own locally-installed `vite` binary (every `files/<name>`
 * is a standalone install per `pnpm create-file`, playbook §4/P0) and
 * falls back to `pnpm exec vite` from that cwd if the local bin isn't
 * there yet (e.g. dependencies not installed).
 */
export async function startViteServer(options: StartViteServerOptions): Promise<ViteServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const readyTimeoutMs = options.readyTimeoutMs ?? 20_000;

  const localBin = join(options.cwd, 'node_modules', '.bin', 'vite');
  const useLocalBin = existsSync(localBin);
  const command = useLocalBin ? localBin : 'pnpm';
  const args = useLocalBin
    ? ['--port', String(options.port), '--host', host, '--strictPort']
    : ['exec', 'vite', '--port', String(options.port), '--host', host, '--strictPort'];

  const child = spawn(command, args, {
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });

  const url = `http://${host}:${options.port}`;

  try {
    await waitUntilReady(url, child, readyTimeoutMs, () => stderrTail);
  } catch (err) {
    await killChild(child).catch(() => {});
    throw err;
  }

  return {
    port: options.port,
    host,
    pid: child.pid ?? -1,
    url,
    process: child,
    stop: () => killChild(child),
  };
}

async function waitUntilReady(
  url: string,
  child: ChildProcess,
  timeoutMs: number,
  getStderr: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  let exitInfo = '';
  child.once('exit', (code, signal) => {
    exited = true;
    exitInfo = `exit code=${code ?? 'null'} signal=${signal ?? 'null'}`;
  });

  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `@ccs/sync-daemon: vite process exited before becoming ready (${exitInfo}). stderr:\n${getStderr()}`,
      );
    }
    try {
      const res = await fetch(url, { method: 'GET' });
      // Vite's dev server responds (2xx/3xx/404 for unknown routes are all
      // "the server is up"); anything that isn't a network error counts.
      if (res.status > 0) return;
    } catch {
      // Not up yet — keep polling.
    }
    await sleep(150);
  }

  throw new Error(`@ccs/sync-daemon: vite server at ${url} did not become ready within ${timeoutMs}ms`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
