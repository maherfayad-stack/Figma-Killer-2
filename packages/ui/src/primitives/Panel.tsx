import * as React from 'react';

/**
 * Panel — a dock section (playbook §2.1/§2.2/§2.3: left sidebar / right
 * sidebar sections). Collapsible header, logical-property padding so it
 * reads correctly under `dir="rtl"`.
 */
export interface PanelProps {
  title: string;
  children?: React.ReactNode;
  defaultCollapsed?: boolean;
  actions?: React.ReactNode;
  /** Stable id used for e2e/test hooks (`data-panel`). */
  id?: string;
}

export function Panel({ title, children, defaultCollapsed = false, actions, id }: PanelProps): React.ReactElement {
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
