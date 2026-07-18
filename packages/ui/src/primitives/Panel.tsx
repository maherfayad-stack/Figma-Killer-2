import * as React from 'react';
import { Icon, type IconName } from '../icons/Icon.js';

/**
 * Panel — a dock section (playbook §2.1/§2.2/§2.3: left sidebar / right
 * sidebar sections). Collapsible header, logical-property padding so it
 * reads correctly under `dir="rtl"`.
 *
 * `icon` (FIX-W4, Inspector Penpot-faithful restructure): purely ADDITIVE and
 * optional — every existing call site that omits it renders byte-identical
 * header markup to before (`{icon && ...}` short-circuits to nothing). Added
 * so `Inspector.tsx`'s section stack can place each section's icon exactly
 * where real Penpot's `title-bar*` component puts it — leading the title
 * text, inside the same clickable collapse toggle — instead of duplicating
 * `Panel`'s header chrome in a one-off local wrapper.
 */
export interface PanelProps {
  title: string;
  children?: React.ReactNode;
  defaultCollapsed?: boolean;
  actions?: React.ReactNode;
  /** Stable id used for e2e/test hooks (`data-panel`). */
  id?: string;
  /** Leading icon in the header, before `title` (Penpot `title-bar*` shape). */
  icon?: IconName;
}

export function Panel({ title, children, defaultCollapsed = false, actions, id, icon }: PanelProps): React.ReactElement {
  const [collapsed, setCollapsed] = React.useState(defaultCollapsed);
  const bodyId = React.useId();
  return (
    <section data-panel={id ?? title} className="ccs-panel" style={{ borderBlockEnd: '1px solid var(--ccs-border)' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingInline: 'var(--ccs-space-3)',
          paddingBlock: 'var(--ccs-space-2)',
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={() => setCollapsed((c) => !c)}
      >
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          style={{
            all: 'unset',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 'var(--ccs-font-size-xs)',
            fontWeight: 600,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: 'var(--ccs-text-muted)',
            cursor: 'pointer',
          }}
        >
          <span
            aria-hidden
            style={{
              display: 'inline-block',
              transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
              transition: 'transform 120ms ease',
            }}
          >
            ▾
          </span>
          {icon && <Icon name={icon} size={12} aria-hidden />}
          {title}
        </button>
        {actions && (
          <span onClick={(e) => e.stopPropagation()} style={{ display: 'flex', gap: 4 }}>
            {actions}
          </span>
        )}
      </header>
      {!collapsed && (
        <div id={bodyId} style={{ paddingInline: 'var(--ccs-space-3)', paddingBlockEnd: 'var(--ccs-space-3)' }}>
          {children}
        </div>
      )}
    </section>
  );
}
