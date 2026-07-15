import * as React from 'react';

/**
 * Menu — shared popover-menu primitive backing both `DropdownMenu`
 * (toolbar/menu-trigger driven) and `ContextMenu` (right-click driven,
 * playbook §2.1 `context_menu.cljs`). WAI-ARIA `menu`/`menuitem` roles,
 * Escape-to-close, click-outside-to-close, full keyboard nav (Up/Down/
 * Home/End) — direction-agnostic (menu items stack in the BLOCK direction,
 * so RTL doesn't change vertical nav semantics).
 */
export interface MenuItemSpec {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  shortcut?: string;
  separatorBefore?: boolean;
}

export interface MenuListProps {
  items: MenuItemSpec[];
  onClose: () => void;
  autoFocus?: boolean;
}

export function MenuList({ items, onClose, autoFocus = true }: MenuListProps): React.ReactElement {
  const listRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (autoFocus) {
      const first = listRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])');
      first?.focus();
    }
  }, [autoFocus]);

  function onKeyDown(e: React.KeyboardEvent) {
    const focusable = Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [],
    );
    const currentIndex = focusable.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusable[(currentIndex + 1) % focusable.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusable[(currentIndex - 1 + focusable.length) % focusable.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusable[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      focusable[focusable.length - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  return (
    <div
      ref={listRef}
      role="menu"
      onKeyDown={onKeyDown}
      style={{
        display: 'flex',
        flexDirection: 'column',
        minInlineSize: 180,
        background: 'var(--ccs-bg-overlay)',
        border: '1px solid var(--ccs-border-strong)',
        borderRadius: 'var(--ccs-radius-md)',
        boxShadow: 'var(--ccs-shadow-overlay)',
        padding: 4,
      }}
    >
      {items.map((item) => (
        <React.Fragment key={item.id}>
          {item.separatorBefore && (
            <div role="separator" style={{ blockSize: 1, background: 'var(--ccs-border)', marginBlock: 4 }} />
          )}
          <button
            role="menuitem"
            type="button"
            disabled={item.disabled}
            onClick={() => {
              item.onSelect();
              onClose();
            }}
            style={{
              all: 'unset',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
              paddingInline: 10,
              paddingBlock: 6,
              borderRadius: 'var(--ccs-radius-sm)',
              fontSize: 'var(--ccs-font-size-sm)',
              color: item.disabled ? 'var(--ccs-text-subtle)' : item.danger ? 'var(--ccs-text-danger)' : 'var(--ccs-text)',
              cursor: item.disabled ? 'not-allowed' : 'pointer',
            }}
            onMouseEnter={(e) => {
              if (!item.disabled) e.currentTarget.style.background = 'var(--ccs-bg-hover)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          >
            <span>{item.label}</span>
            {item.shortcut && (
              <span style={{ fontSize: 'var(--ccs-font-size-xs)', color: 'var(--ccs-text-subtle)' }}>{item.shortcut}</span>
            )}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}

export interface DropdownMenuProps {
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean }) => React.ReactElement;
  items: MenuItemSpec[];
}

export function DropdownMenu({ trigger, items }: DropdownMenuProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      {trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open })}
      {open && (
        <div style={{ position: 'absolute', insetBlockStart: '100%', insetInlineStart: 0, zIndex: 1000, marginBlockStart: 4 }}>
          <MenuList items={items} onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

export interface ContextMenuProps {
  children: React.ReactElement;
  items: MenuItemSpec[] | (() => MenuItemSpec[]);
}

/** Right-click menu (playbook §2.1 `context_menu.cljs`). Positions at the
 * pointer using logical inset properties computed from the container's own
 * writing direction, so it opens toward text-flow-start under RTL rather
 * than clipping off the physical left edge. */
export function ContextMenu({ children, items }: ContextMenuProps): React.ReactElement {
  const [pos, setPos] = React.useState<{ x: number; y: number } | null>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  function onContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    setPos({ x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) });
  }

  const resolvedItems = typeof items === 'function' ? items() : items;

  return (
    <div ref={containerRef} onContextMenu={onContextMenu} style={{ position: 'relative' }}>
      {children}
      {pos && (
        <div
          data-testid="context-menu"
          style={{ position: 'absolute', insetBlockStart: pos.y, insetInlineStart: pos.x, zIndex: 1000 }}
        >
          <MenuList items={resolvedItems} onClose={() => setPos(null)} />
        </div>
      )}
    </div>
  );
}
