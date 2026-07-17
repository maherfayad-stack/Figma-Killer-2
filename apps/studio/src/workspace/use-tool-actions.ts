import * as React from 'react';
import type { StudioCanvasHandle } from '@ccs/canvas';
import { frameSourcePath } from '@ccs/canvas';
import { childUid } from '../engine/tree-nav.js';
import { useDaemonConnection } from '../engine/daemon-connection.js';
import { useWorkspaceStore } from './workspace-store.js';

/**
 * FP-3 tool-action bridge (`.orchestrator/FEATURE-PARITY-PLAN.md` §2 FP-3):
 * the missing piece the plan calls out — `Toolbar.tsx` sets `activeTool` in
 * `workspace-store` but nothing ever consumed it. This hook is that
 * consumer: it turns a tool "activation" into a real daemon-backed
 * `CanvasOp`/`create-frame` request, reusing EVERY existing op/flow rather
 * than inventing a new one (playbook §0/The One Rule):
 *   - Frame  -> `StudioCanvasHandle.createFrame` (the exact `CreateFrameFn`/
 *     `defaultCreateFrame` path the "+ New Frame" form in `StudioCanvas.tsx`
 *     already uses — see that file's doc).
 *   - Text/Image -> `insert-node` (`kind:'element'`) + `set-text`/`set-prop`
 *     (the same two-step "insert then patch the new uid" pattern
 *     `use-component-insert.ts`'s `ds-component` insert already establishes,
 *     including its `childUid` uid-prediction CR).
 *
 * MVP decision (see report): activating Frame/Text/Image performs ONE
 * immediate action then reverts `activeTool` to `'select'` — there is no
 * Penpot-style "arm the tool, then drag/click on canvas to place it" step,
 * because our frames/elements aren't free-floating vector shapes (playbook
 * §0): a frame's placement is `defaultGeometryForIndex`'s cascade, and a
 * text/image element's placement is "append to the active frame's root (or
 * the current selection)" — both already fully determined without a canvas
 * gesture, so adding a placement step would be pure UI theater, not a real
 * capability. Select/Comment stay persistent "modes" (Comment is an
 * explicit FP-5 stub); Insert-component just switches the left tab.
 */

/** Lowest-numbered `Frame<N>` not already used by an existing frame in the
 * same file-folder (Penpot auto-names boards the same way — incrementing a
 * numeric suffix, `../penpot/frontend/src/app/main/data/workspace.cljs`
 * `generate-unique-name`). PascalCase, no space: our frame names double as
 * both the `.tsx` file name and the component identifier
 * (`new-frame.ts`'s `isValidFrameName`), unlike Penpot's free-text board
 * name — so `"Frame 1"` is not an option here. Exported for the unit test;
 * pure and dependency-free like `childUid`/`isValidFrameName`. */
export function nextFrameName(existingNames: ReadonlySet<string>): string {
  let n = 1;
  while (existingNames.has(`Frame${n}`)) n += 1;
  return `Frame${n}`;
}

export interface ToolActions {
  /** Gates Text/Image: an element can only be inserted into a frame whose
   * live tree we already have (the user has selected a frame/element in
   * Layers or on canvas — same precondition `useComponentInsert` requires). */
  hasActiveFrame: boolean;
  /** Gates Frame: we need both a mounted canvas (for `createFrame`) and a
   * known file-folder to create into. */
  canCreateFrame: boolean;
  /** Frame (F): auto-names + creates a new frame, selects it, then reverts
   * `activeTool` to `'select'`. No-op if `!canCreateFrame`. */
  createFrame(): void;
  /** Text (T): inserts a `<p>` placeholder ("Text") into the active frame
   * (or selection), selects it, then reverts `activeTool` to `'select'`.
   * No-op if `!hasActiveFrame`. */
  insertText(): void;
  /** Image: inserts an `<img>` with the given `src` (a data-URI for the MVP
   * — see report §5) into the active frame (or selection), selects it, then
   * reverts `activeTool` to `'select'`. No-op if `!hasActiveFrame`. */
  insertImage(src: string): void;
}

export function useToolActions(canvasHandle: StudioCanvasHandle | null): ToolActions {
  const { sendOp, frames } = useDaemonConnection();
  const fileFolder = useWorkspaceStore((s) => s.fileFolder);
  // NOTE (same fix `Inspector.tsx` documents): call the getter INSIDE the
  // selector so zustand subscribes to the computed value, not the stable
  // function reference.
  const tree = useWorkspaceStore((s) => s.currentTree());
  const selectedNode = useWorkspaceStore((s) => s.selectedNode());
  const selectFrame = useWorkspaceStore((s) => s.selectFrame);
  const selectNode = useWorkspaceStore((s) => s.selectNode);
  const setTool = useWorkspaceStore((s) => s.setTool);

  // Same fallback `StudioCanvas`'s own "+ New Frame" form uses
  // (`defaultFileFolder = frames[0]?.fileFolder`) for the common case where
  // the user hasn't yet clicked a frame/layer row this session (so
  // `workspace-store.fileFolder` is still `null`) — a freshly-opened
  // project always has at least the template's frames already known via
  // `useDaemonConnection().frames`.
  const targetFileFolder = fileFolder ?? frames[0]?.fileFolder ?? null;
  const canCreateFrame = canvasHandle !== null && targetFileFolder !== null;

  const createFrame = React.useCallback(() => {
    if (!canvasHandle || !targetFileFolder) return;
    const existingNames = new Set(frames.filter((f) => f.fileFolder === targetFileFolder).map((f) => f.name));
    const name = nextFrameName(existingNames);
    canvasHandle
      .createFrame({ fileFolder: targetFileFolder, name })
      .then(() => selectFrame(targetFileFolder, frameSourcePath(name)))
      .catch((err: unknown) => {
        // No toast system in this chrome yet (playbook §5.8/report) —
        // surface to the console rather than fail silently, matching
        // `StudioCanvas`'s own `duplicate-frame` failure handling.
        console.error('@ccs/studio: Frame tool create-frame failed', err);
      })
      .finally(() => setTool('select'));
  }, [canvasHandle, targetFileFolder, frames, selectFrame, setTool]);

  const insertText = React.useCallback(() => {
    if (!tree) return;
    const target = selectedNode ?? tree;
    const index = target.children.length;
    sendOp({ t: 'insert-node', parentUid: target.uid, index, source: { kind: 'element', tag: 'p' } });
    const newUid = childUid(target.uid, index);
    sendOp({ t: 'set-text', uid: newUid, text: 'Text' });
    selectNode(newUid);
    setTool('select');
  }, [tree, selectedNode, sendOp, selectNode, setTool]);

  const insertImage = React.useCallback(
    (src: string) => {
      if (!tree) return;
      const target = selectedNode ?? tree;
      const index = target.children.length;
      sendOp({ t: 'insert-node', parentUid: target.uid, index, source: { kind: 'element', tag: 'img' } });
      const newUid = childUid(target.uid, index);
      sendOp({ t: 'set-prop', uid: newUid, name: 'src', value: src });
      sendOp({ t: 'set-prop', uid: newUid, name: 'alt', value: 'Image' });
      selectNode(newUid);
      setTool('select');
    },
    [tree, selectedNode, sendOp, selectNode, setTool],
  );

  return { hasActiveFrame: tree !== null, canCreateFrame, createFrame, insertText, insertImage };
}
