/**
 * Per-file op serialization (playbook §4/P1 step 3: "queue it, serialize
 * per file"). Even though P1's `onCanvasOp` handler is a stub (real AST
 * application is P3), the queueing discipline is real: ops targeting the
 * same source file always run strictly in arrival order, one at a time,
 * so P3's ast-engine can drop in behind this without a concurrency
 * redesign.
 */
export class FileOpQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  enqueue<T>(file: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(file) ?? Promise.resolve();
    const settled = previous.then(task, task);
    // Swallow so a failed task doesn't poison the chain for the next op on
    // the same file; each `enqueue` caller still observes its own
    // rejection via the returned promise.
    this.tails.set(
      file,
      settled.then(
        () => undefined,
        () => undefined,
      ),
    );
    return settled;
  }
}
