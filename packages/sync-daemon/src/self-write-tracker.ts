/**
 * Self-write suppression (ADR-0013 carry-forward: "add a generation-counter/
 * self-write suppression before P3 if noisy"). The chokidar watcher
 * (`watcher.ts`) fires `file-changed`/`hmr-update` on ANY change to a frame
 * source file — including the daemon's OWN atomic writes from the P3
 * write-through path (`op-apply.ts`) and undo/redo. Without suppression
 * every canvas op would produce a duplicate pair of events: one broadcast
 * explicitly by the op-write path (which already knows exactly what
 * changed and can pair it with `uid-remap`/`op-applied`) and one
 * rediscovered independently by the filesystem watcher a few dozen
 * milliseconds later once `awaitWriteFinish` settles.
 *
 * Mechanism: before performing an atomic write the daemon "marks" the
 * absolute path here; the watcher's change handler calls `consume()` first
 * — if it returns true (this path was just self-written), the watcher
 * swallows that one notification instead of emitting. A simple counter
 * (not a boolean) survives back-to-back writes to the same file arriving
 * before the watcher's debounce fires for the first one.
 */
export class SelfWriteTracker {
  private readonly pending = new Map<string, number>();

  /** Call immediately before writing `absPath` to disk. */
  markWritten(absPath: string): void {
    this.pending.set(absPath, (this.pending.get(absPath) ?? 0) + 1);
  }

  /**
   * Call from the watcher's change handler. Returns `true` (and consumes
   * one pending mark) if `absPath` was just written by the daemon itself
   * — the caller should suppress its own emission in that case. Returns
   * `false` for a genuinely external change.
   */
  consume(absPath: string): boolean {
    const count = this.pending.get(absPath);
    if (!count) return false;
    if (count <= 1) this.pending.delete(absPath);
    else this.pending.set(absPath, count - 1);
    return true;
  }
}
