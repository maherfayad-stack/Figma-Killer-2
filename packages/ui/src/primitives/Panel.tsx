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
  /** W4b-9 (audit rule A1) — Penpot's `title-bar*` contract
   * (`ui/components/title_bar.cljs:14-42`): an EMPTY optional section (no
   * collapsable content yet) renders `.title-only` — the label ALONE, no
   * disclosure chevron, no collapse toggle, body always visible (there's
   * nothing to hide). A POPULATED section is the normal collapsible header.
   * Additive and optional, defaulting to `true` — every EXISTING caller that
   * omits this prop renders byte-identically to before (same chevron, same
   * collapse toggle, same behavior). Only a caller that explicitly passes
   * `collapsible={false}` (this workstream's `AddableSection` in
   * `Inspector.tsx`, for its own empty state) gets the title-only header. */
  collapsible?: boolean;
}

export function Panel({
  title,
  children,
  defaultCollapsed = false,
  actions,
  id,
  icon,
  collapsible = true,
}: PanelProps): React.ReactElement {
  const [collapsed, setCollapsed] = React.useState(defaultCollapsed);
  const bodyId = React.useId();
  // `collapsible` gates whether the CURRENT `collapsed` state actually hides
  // the body — a title-only header (`collapsible={false}`) always shows its
  // body, regardless of the (unused, in that mode) toggle state.
  const isCollapsed = collapsible && collapsed;
  return (
    <section
      data-panel={id ?? title}
      className="ccs-panel"
      style={{ borderBlockEnd: '1px solid var(--ccs-border)' }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingInline: 'var(--ccs-space-3)',
          paddingBlock: 'var(--ccs-space-2)',
          cursor: collapsible ? 'pointer' : 'default',
          userSelect: 'none',
        }}
        onClick={collapsible ? () => setCollapsed((c) => !c) : undefined}
      >
        {collapsible ? (
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
            {/* FIX-W4b-2: real Penpot disclosure icons — its own `title-bar*`
             * (`app.main.ui.components.title-bar`) swaps between the vendored
             * `arrow-right`/`arrow-down` glyphs by `collapsed` state rather than
             * rotating one chevron; reproduced exactly (no CSS rotate) instead
             * of this file's prior hardcoded "▾" text glyph. */}
            <Icon
              name={collapsed ? 'arrow-right' : 'arrow-down'}
              size={12}
              aria-hidden
              style={{ flexShrink: 0 }}
            />
            {icon && <Icon name={icon} size={12} aria-hidden />}
            {title}
          </button>
        ) : (
          // W4b-9 — Penpot's `.title-only` (title_bar.cljs:33-34): plain label,
          // no button, no chevron. Not a `<button>` at all — nothing to toggle.
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 'var(--ccs-font-size-xs)',
              fontWeight: 600,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: 'var(--ccs-text-muted)',
            }}
          >
            {icon && <Icon name={icon} size={12} aria-hidden />}
            {title}
          </span>
        )}
        {actions && (
          <span onClick={(e) => e.stopPropagation()} style={{ display: 'flex', gap: 4 }}>
            {actions}
          </span>
        )}
      </header>
      {!isCollapsed && (
        <div
          id={bodyId}
          style={{ paddingInline: 'var(--ccs-space-3)', paddingBlockEnd: 'var(--ccs-space-3)' }}
        >
          {children}
        </div>
      )}
    </section>
  );
}
