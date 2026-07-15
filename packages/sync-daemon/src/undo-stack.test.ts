import { describe, expect, it } from 'vitest';
import type { CanvasOp } from '@ccs/protocol';
import { UndoRedoManager, type UndoEntry } from './undo-stack.js';

function makeEntry(uid: string, text: string): UndoEntry {
  const forwardOp: CanvasOp = { t: 'set-text', uid: uid as never, text };
  return {
    absFilePath: '/proj/files/demo/src/frames/Hero.tsx',
    relPath: 'src/frames/Hero.tsx',
    forwardOp,
    inverseOp: { t: 'set-text', uid: uid as never, text: 'original' },
  };
}

describe('UndoRedoManager', () => {
  it('pops entries LIFO per file-folder', () => {
    const mgr = new UndoRedoManager();
    mgr.recordApplied('demo', makeEntry('src/frames/Hero.tsx:d0', 'a'));
    mgr.recordApplied('demo', makeEntry('src/frames/Hero.tsx:d0', 'b'));

    expect(mgr.undoDepth('demo')).toBe(2);
    const top = mgr.popUndo('demo');
    expect(top?.forwardOp).toEqual({ t: 'set-text', uid: 'src/frames/Hero.tsx:d0', text: 'b' });
    expect(mgr.undoDepth('demo')).toBe(1);
  });

  it('recording a new op clears the redo stack', () => {
    const mgr = new UndoRedoManager();
    mgr.recordApplied('demo', makeEntry('u', 'a'));
    const entry = mgr.popUndo('demo')!;
    mgr.pushRedo('demo', entry);
    expect(mgr.redoDepth('demo')).toBe(1);

    mgr.recordApplied('demo', makeEntry('u', 'c'));
    expect(mgr.redoDepth('demo')).toBe(0);
  });

  it('keeps separate stacks per file-folder', () => {
    const mgr = new UndoRedoManager();
    mgr.recordApplied('demo', makeEntry('u', 'a'));
    mgr.recordApplied('other', makeEntry('u', 'a'));
    expect(mgr.undoDepth('demo')).toBe(1);
    expect(mgr.undoDepth('other')).toBe(1);
    mgr.popUndo('demo');
    expect(mgr.undoDepth('demo')).toBe(0);
    expect(mgr.undoDepth('other')).toBe(1);
  });

  it('peekUndo/peekRedo do not remove the entry', () => {
    const mgr = new UndoRedoManager();
    mgr.recordApplied('demo', makeEntry('u', 'a'));
    const peeked = mgr.peekUndo('demo');
    expect(peeked).toBeDefined();
    expect(mgr.undoDepth('demo')).toBe(1);
  });

  it('pushUndo restores an entry after a failed apply attempt', () => {
    const mgr = new UndoRedoManager();
    mgr.recordApplied('demo', makeEntry('u', 'a'));
    const entry = mgr.popUndo('demo')!;
    expect(mgr.undoDepth('demo')).toBe(0);
    mgr.pushUndo('demo', entry);
    expect(mgr.undoDepth('demo')).toBe(1);
  });

  it('popUndo/popRedo on an empty/unknown file-folder returns undefined', () => {
    const mgr = new UndoRedoManager();
    expect(mgr.popUndo('nope')).toBeUndefined();
    expect(mgr.popRedo('nope')).toBeUndefined();
  });
});
