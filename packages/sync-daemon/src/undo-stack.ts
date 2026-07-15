import type { CanvasOp } from '@ccs/protocol';
import type { InverseOp } from '@ccs/ast-engine';

/**
 * One undo-able step: the forward op that was applied, the inverse ast-
 * engine computed for it (BEFORE applying, against the pre-image — ADR-
 * 0018 item 9), and which file on disk it targets. Keeping both the
 * forward op and its inverse (rather than just the inverse) is what lets
 * `redo` simply re-run `applyOp(forwardOp)` instead of trying to invert
 * the inverse.
 */
export interface UndoEntry {
  /** Absolute path on disk. */
  absFilePath: string;
  /** File-folder-relative path (matches the op's NodeUid relPath) — used
   * to build the file-folder-relative `uid-remap` event. */
  relPath: string;
  forwardOp: CanvasOp;
  inverseOp: InverseOp;
}

/**
 * Per-file-folder undo/redo stacks (ADR-0018 item 9: the stack lives in
 * the DAEMON, not ast-engine). Scoped by file-folder NAME (not by
 * individual file) — a studio "undo" is "undo my last change in this
 * project", which may have targeted any file within it.
 *
 * A fresh forward op recorded via `recordApplied` clears that file-
 * folder's redo stack (standard undo/redo semantics: you can't redo past
 * a new edit).
 */
export class UndoRedoManager {
  private readonly undoStacks = new Map<string, UndoEntry[]>();
  private readonly redoStacks = new Map<string, UndoEntry[]>();

  recordApplied(fileFolderName: string, entry: UndoEntry): void {
    const stack = this.undoStacks.get(fileFolderName) ?? [];
    stack.push(entry);
    this.undoStacks.set(fileFolderName, stack);
    this.redoStacks.set(fileFolderName, []);
  }

  /** Non-destructive lookup of what the next `popUndo` would return —
   * used by callers that need to know WHICH file an undo will touch
   * before they can pick a `FileOpQueue` key to serialize on. */
  peekUndo(fileFolderName: string): UndoEntry | undefined {
    const stack = this.undoStacks.get(fileFolderName);
    return stack?.[stack.length - 1];
  }

  peekRedo(fileFolderName: string): UndoEntry | undefined {
    const stack = this.redoStacks.get(fileFolderName);
    return stack?.[stack.length - 1];
  }

  popUndo(fileFolderName: string): UndoEntry | undefined {
    return this.undoStacks.get(fileFolderName)?.pop();
  }

  popRedo(fileFolderName: string): UndoEntry | undefined {
    return this.redoStacks.get(fileFolderName)?.pop();
  }

  /** Puts an entry back on the undo stack — used when an undo/redo
   * application fails the concurrent-edit guard, so the attempt can be
   * retried without losing history. */
  pushUndo(fileFolderName: string, entry: UndoEntry): void {
    const stack = this.undoStacks.get(fileFolderName) ?? [];
    stack.push(entry);
    this.undoStacks.set(fileFolderName, stack);
  }

  pushRedo(fileFolderName: string, entry: UndoEntry): void {
    const stack = this.redoStacks.get(fileFolderName) ?? [];
    stack.push(entry);
    this.redoStacks.set(fileFolderName, stack);
  }

  undoDepth(fileFolderName: string): number {
    return this.undoStacks.get(fileFolderName)?.length ?? 0;
  }

  redoDepth(fileFolderName: string): number {
    return this.redoStacks.get(fileFolderName)?.length ?? 0;
  }
}
