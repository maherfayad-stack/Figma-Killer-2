import * as React from 'react';
import { useSelectionStore } from './selection-store.js';
import type { ElementSelection } from './studio-canvas-types.js';

/**
 * FP-4a: reports the currently-selected ELEMENT (canvas-originated: a real
 * hit-test click, or a `text-edit`-adjacent selection set inside
 * `edit-mode-layer.tsx`) up to the caller — see
 * `StudioCanvasProps.onElementSelect`'s doc. Reads `useSelectionStore`
 * directly (module-level zustand, no React-context boundary needed) rather
 * than requiring `edit-mode-layer.tsx` to accept yet another prop; dedupes
 * on a composite key so it only fires when the reported selection actually
 * changes, mirroring `FrameSelectionBridge`'s own dedupe pattern.
 *
 * Sub-workstream 2d-ii: moved verbatim out of `StudioCanvas.tsx` into its
 * own module — per `CANVAS-ENGINE-DESIGN.md`'s own call-out, this component
 * reads ONLY `selection-store.ts` (already engine-agnostic, confirmed by
 * this file's imports), so it's genuinely SHARED between `TldrawEngineCanvas`
 * and `CustomEngineCanvas` rather than needing an engine-specific copy —
 * no behavior change from the original.
 */
export function ElementSelectionBridge({
  onElementSelect,
}: {
  onElementSelect: (selection: ElementSelection | null) => void;
}): null {
  const editModeFrame = useSelectionStore((s) => s.editModeFrame);
  const selectedUid = useSelectionStore((s) => s.selectedUids[0] ?? null);
  const lastReportedRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    const selection: ElementSelection | null =
      editModeFrame && selectedUid
        ? { fileFolder: editModeFrame.fileFolder, framePath: editModeFrame.framePath, uid: selectedUid }
        : null;
    const key = selection ? `${selection.fileFolder}::${selection.framePath}::${selection.uid}` : null;
    if (lastReportedRef.current === key) return;
    lastReportedRef.current = key;
    onElementSelect(selection);
  }, [editModeFrame, selectedUid, onElementSelect]);

  return null;
}
