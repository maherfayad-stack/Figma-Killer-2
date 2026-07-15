import * as React from 'react';
import { Button, Tooltip } from '@ccs/ui';
import { useWorkspaceStore, type ToolId } from './workspace-store.js';

/**
 * Toolbar (playbook §2.1 `top_toolbar.cljs`): "select / frame / insert-
 * component (opens palette) / text / image / comment(stub)".
 */
const TOOLS: { id: ToolId; label: string; icon: string }[] = [
  { id: 'select', label: 'Select (V)', icon: '↖' },
  { id: 'frame', label: 'Frame (F)', icon: '▭' },
  { id: 'insert-component', label: 'Insert component (I)', icon: '◇' },
  { id: 'text', label: 'Text (T)', icon: 'T' },
  { id: 'image', label: 'Image', icon: '▧' },
  { id: 'comment', label: 'Comment (stub)', icon: '💬' },
];

export interface ToolbarProps {
  onOpenComponentPalette: () => void;
}

export function Toolbar({ onOpenComponentPalette }: ToolbarProps): React.ReactElement {
  const activeTool = useWorkspaceStore((s) => s.activeTool);
  const setTool = useWorkspaceStore((s) => s.setTool);

  return (
    <div
      role="toolbar"
      aria-label="Tools"
      data-testid="toolbar"
      style={{
        display: 'flex',
        gap: 4,
        alignItems: 'center',
        paddingInline: 8,
        paddingBlock: 6,
        background: 'var(--ccs-bg-panel)',
        borderBlockEnd: '1px solid var(--ccs-border)',
      }}
    >
      {TOOLS.map((tool) => (
        <Tooltip key={tool.id} label={tool.label}>
          <Button
            variant="icon"
            active={activeTool === tool.id}
            aria-label={tool.label}
            onClick={() => {
              setTool(tool.id);
              if (tool.id === 'insert-component') onOpenComponentPalette();
            }}
          >
            <span aria-hidden>{tool.icon}</span>
          </Button>
        </Tooltip>
      ))}
    </div>
  );
}
