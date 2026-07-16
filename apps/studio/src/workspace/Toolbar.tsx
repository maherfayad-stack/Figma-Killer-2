import * as React from 'react';
import { Button, Tooltip, Icon, type IconName } from '@ccs/ui';
import { useWorkspaceStore, type ToolId } from './workspace-store.js';

/**
 * Toolbar (playbook §2.1 `top_toolbar.cljs`; spec §5.8): "select / frame /
 * insert-component (opens palette) / text / image / comment(stub)", real
 * vector icons instead of glyphs/emoji.
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
            <Icon name={tool.icon} size={16} />
          </Button>
        </Tooltip>
      ))}
    </div>
  );
}
