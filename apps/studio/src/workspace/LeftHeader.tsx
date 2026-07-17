import * as React from 'react';
import { Button, DropdownMenu, Icon } from '@ccs/ui';

/**
 * LeftHeader — the left-pane header (FP-2, `.orchestrator/
 * FEATURE-PARITY-PLAN.md` §2; `.orchestrator/PENPOT-FIDELITY-SPEC.md`
 * §5.1: "a LEFT header ... each 52px"). Structure pulled directly from the
 * real Penpot source (studied per orchestrator directive):
 *   - `../penpot/frontend/src/app/main/ui/workspace/left_header.cljs` —
 *     `left-header*`: a logo (`.main-icon`, click = `go-back` to the
 *     dashboard) then a `.project-tree` holding the file name, where
 *     double-clicking the name (`start-editing-name`) swaps it for an
 *     `<input>` (`file-name-input`) that commits on blur or Enter
 *     (`handle-blur`/`handle-name-keydown`) — reimplemented 1:1 below
 *     (`editing` state + `inputRef` + `handleCommit`/`handleKeyDown`).
 *     Penpot then renders `[:> main-menu/menu* ...]` in a trailing
 *     `.menu-section` — our equivalent is the trailing kebab `DropdownMenu`.
 *   - `left_header.scss` — the proportions this mirrors: `min-height: 52px`
 *     (`--ccs-header-height`), the logo at 32×32 with a small trailing
 *     margin, file-name using a small/medium title style.
 *
 * FP-2 folds `TopBar.tsx`'s content in here (see that file's own former
 * module doc) rather than a single global top bar — Penpot has none.
 */
export interface LeftHeaderProps {
  fileName: string;
  onBackToDashboard: () => void;
  onRenameFile: (name: string) => void;
}

export function LeftHeader({ fileName, onBackToDashboard, onRenameFile }: LeftHeaderProps): React.ReactElement {
  const [editing, setEditing] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function startEditing(): void {
    setEditing(true);
  }

  function commit(): void {
    const value = inputRef.current?.value.trim() ?? '';
    if (value) onRenameFile(value);
    setEditing(false);
  }

  return (
    <header
      data-testid="left-header"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--ccs-space-2)',
        paddingInline: 'var(--ccs-space-3)',
        blockSize: 'var(--ccs-header-height)',
        minBlockSize: 'var(--ccs-header-height)',
        background: 'var(--ccs-bg-panel)',
        borderBlockEnd: '1px solid var(--ccs-border)',
      }}
    >
      <button
        type="button"
        aria-label="Back to dashboard"
        title="Back to dashboard"
        onClick={onBackToDashboard}
        style={{
          all: 'unset',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          inlineSize: 32,
          blockSize: 32,
          borderRadius: 'var(--ccs-radius-sm)',
          background: 'var(--ccs-accent)',
          color: 'var(--ccs-accent-contrast)',
          fontWeight: 700,
          fontSize: 14,
          cursor: 'pointer',
        }}
      >
        C
      </button>

      <div style={{ flex: 1, minInlineSize: 0 }}>
        {editing ? (
          <input
            ref={inputRef}
            type="text"
            aria-label="File name"
            defaultValue={fileName}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              } else if (e.key === 'Escape') {
                setEditing(false);
              }
            }}
            style={{
              inlineSize: '100%',
              background: 'var(--ccs-bg-input)',
              color: 'var(--ccs-text)',
              border: '1px solid var(--ccs-border-focus)',
              borderRadius: 'var(--ccs-radius-sm)',
              paddingInline: 8,
              paddingBlock: 4,
              fontSize: 'var(--ccs-font-size-md)',
              fontFamily: 'inherit',
            }}
          />
        ) : (
          <strong
            data-testid="file-name"
            title={`${fileName} — double-click to rename`}
            onDoubleClick={startEditing}
            style={{
              display: 'block',
              fontSize: 'var(--ccs-font-size-md)',
              fontWeight: 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              cursor: 'text',
            }}
          >
            {fileName}
          </strong>
        )}
      </div>

      <DropdownMenu
        trigger={({ onClick, 'aria-expanded': expanded }) => (
          <Button variant="icon" aria-label="File menu" aria-expanded={expanded} onClick={onClick}>
            <Icon name="menu" size={16} />
          </Button>
        )}
        items={[
          { id: 'rename', label: 'Rename file', onSelect: startEditing },
          { id: 'dashboard', label: 'Back to dashboard', onSelect: onBackToDashboard, separatorBefore: true },
        ]}
      />
    </header>
  );
}
