import net from 'node:net';

/**
 * Port allocation for the daemon's own control ws + the per-file-folder
 * Vite dev server pool (playbook §4/P1 step 2: "port pool from 5200+").
 * Binds a throwaway probe socket to 127.0.0.1 only — matches every other
 * socket this package opens (BOUNDARIES: "Bind all sockets to 127.0.0.1
 * only").
 */
export async function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => {
      probe.close(() => resolve(true));
    });
  });
}

/**
 * Find the first free port at or after `start`, skipping anything in
 * `taken` (ports this same daemon process has already claimed but whose
 * listener may not be bound yet at call time — e.g. mid-allocation-loop).
 */
export async function allocatePort(
  start: number,
  taken: ReadonlySet<number> = new Set(),
  host = '127.0.0.1',
): Promise<number> {
  let port = start;
  // 5200..6199 is a generous ceiling — bail out rather than loop forever if
  // something is very wrong (e.g. host resolution failing repeatedly).
  const ceiling = start + 1000;
  while (port <= ceiling) {
    if (!taken.has(port) && (await isPortFree(port, host))) return port;
    port++;
  }
  throw new Error(`@ccs/sync-daemon: no free port found in [${start}, ${ceiling}]`);
}
