import * as React from 'react';
import { Button, Tooltip, Icon, type IconName } from '@ccs/ui';
import type { StudioCanvasHandle } from '@ccs/canvas';
import { useWorkspaceStore, type ToolId } from './workspace-store.js';
import { useToolActions } from './use-tool-actions.js';

/**
 * Toolbar (FP-3, `.orchestrator/FEATURE-PARITY-PLAN.md` §2; spec §5.8; real
 * Penpot source studied per orchestrator directive: `../penpot/frontend/
 * src/app/main/ui/workspace/top_toolbar.cljs` + `top_toolbar.scss`):
 *
 *   - **Floats over the canvas, top-center** — Penpot's `.toolbar` is
 *     `position: absolute; inset-inline-start: 50%; transform:
 *     translateX(-50%)` pinned near the viewport's top edge, NOT a chrome
 *     row; `WorkspaceShell.tsx` gives `<main>` `position: relative` and this
 *     component is absolutely positioned within it so it overlays
 *     `canvas-area` exactly the same way (see that file's doc).
 *   - **8px radius, 2px border pill** — Penpot: `border-radius: $br-8`
 *     (8px), `border: $b-2 solid var(--menu-border-color)`, `background-
 *     color: var(--menu-background-color)`, `padding: var(--sp-m)` (12px).
 *   - **Real vector icons, ghost icon-buttons, `aria-pressed` active state**
 *     — Penpot's `icon-button*` (`variant="ghost"`, `aria-pressed`) per
 *     tool; ours is `@ccs/ui`'s `Button variant="icon" active={...}`.
 *   - **Tooltip with shortcut in the label** — Penpot's `tool-label` composes
 *     the i18n name with `sc/get-tooltip` (e.g. "Move (V)"); ours bakes the
 *     shortcut into each `Tooltip`'s `label` string directly (no i18n layer
 *     to plug into yet).
 *
 * Tools = our code-first adaptation (spec §5.8): Move/Select(V) · Frame(F) ·
 * Insert-component(I) · Text(T) · Image · Comment(stub) — no vector/shape
 * flyouts (playbook §0: no vector tools).
 *
 * FP-3's actual wiring (the gap this phase closes — `activeTool` used to be
 * set and never consumed): every click routes through `useToolActions`
 * (`use-tool-actions.ts`), the SAME bridge `use-tool-keymap.ts` uses for the
 * V/F/T/I/C shortcuts, so a click and its keyboard shortcut are always one
 * code path, never two. Text/Image are `disabled` (not just silently a
 * no-op) when there's no active frame to insert into (spec: "clear
 * affordance") — Frame is `disabled` until the canvas has mounted and a
 * file-folder is known.
 */
const TOOLS: { id: ToolId; label: string; icon: IconName }[] = [
  { id: 'select', label: 'Select (V)', icon: 'move' },
  { id: 'frame', label: 'Frame (F)', icon: 'board' },
  { id: 'insert-component', label: 'Insert component (I)', icon: 'component' },
  { id: 'text', label: 'Text (T)', icon: 'text' },
  { id: 'image', label: 'Image', icon: 'img' },
  { id: 'comment', label: 'Comment (stub)', icon: 'comments' },
];

export interface ToolbarProps {
  onOpenComponentPalette: () => void;
  /** The FP-1 `onReady` camera handle, extended in FP-3 with `createFrame`
   * (see `@ccs/canvas`'s `StudioCanvasHandle`) — `null` until the tldraw
   * editor has mounted, which disables the Frame tool (see `useToolActions`). */
  canvasHandle: StudioCanvasHandle | null;
}

export function Toolbar({ onOpenComponentPalette, canvasHandle }: ToolbarProps): React.ReactElement {
  const activeTool = useWorkspaceStore((s) => s.activeTool);
  const setTool = useWorkspaceStore((s) => s.setTool);
  const actions = useToolActions(canvasHandle);
  const imageInputRef = React.useRef<HTMLInputElement>(null);

  function handleToolClick(tool: ToolId): void {
    switch (tool) {
      case 'select':
        setTool('select');
        return;
      case 'comment':
        // FP-5 stub (spec §5.8: "Comment(P7 stub)") — switches the tool
        // marker only; no pin/thread behavior exists yet.
        setTool('comment');
        return;
      case 'frame':
        setTool('frame');
        actions.createFrame();
        return;
      case 'text':
        setTool('text');
        actions.insertText();
        return;
      case 'image':
        setTool('image');
        imageInputRef.current?.click();
        return;
      case 'insert-component':
        setTool('insert-component');
        onOpenComponentPalette();
        return;
    }
  }

  function handleImageFileChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file next time
    if (!file) {
      setTool('select'); // user cancelled the picker — don't leave Image "armed"
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') actions.insertImage(reader.result);
    };
    reader.readAsDataURL(file);
  }

  const isToolDisabled = (id: ToolId): boolean => {
    if (id === 'frame') return !actions.canCreateFrame;
    if (id === 'text' || id === 'image') return !actions.hasActiveFrame;
    return false;
  };

  return (
    <div
      role="toolbar"
      aria-label="Tools"
      data-testid="toolbar"
      style={{
        position: 'absolute',
        insetBlockStart: 12,
        insetInlineStart: '50%',
        transform: 'translateX(-50%)',
        zIndex: 10,
        display: 'flex',
        gap: 4,
        alignItems: 'center',
        padding: 'var(--ccs-space-2)',
        borderRadius: 8,
        border: '2px solid var(--ccs-border-strong)',
        background: 'var(--ccs-bg-panel)',
        boxShadow: 'var(--ccs-shadow-overlay)',
      }}
    >
      {TOOLS.map((tool) => (
        <Tooltip key={tool.id} label={tool.label}>
          <Button
            variant="icon"
            active={activeTool === tool.id}
            aria-label={tool.label}
            disabled={isToolDisabled(tool.id)}
            onClick={() => handleToolClick(tool.id)}
          >
            <Icon name={tool.icon} size={16} />
          </Button>
        </Tooltip>
      ))}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        aria-label="Choose an image to insert"
        onChange={handleImageFileChange}
        style={{ display: 'none' }}
      />
    </div>
  );
}
