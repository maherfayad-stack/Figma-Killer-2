/**
 * packages/sync-daemon — per-project Node daemon: boots one Vite dev server
 * per file-folder, exposes a ws server speaking `@ccs/protocol` (CanvasOp
 * in, DaemonEvent out), watches `.studio/canvas.json` + frames dirs with
 * chokidar, and owns git checkpoint commits. Scope: Phase 1 (playbook
 * §4/P1), op-queue/undo lands in Phase 3.
 */
export const SYNC_DAEMON_PACKAGE_PHASE = 'P1' as const;

export function notImplementedYet(feature: string): never {
  throw new Error(`@ccs/sync-daemon: "${feature}" is P1 scope, not implemented in P0`);
}
