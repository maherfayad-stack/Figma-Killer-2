import * as React from 'react';

/**
 * SegmentedGroup — FIX-W4b-5. Real Penpot's `radio-buttons*`/`icon-button*`
 * anatomy (`../penpot/frontend/src/app/main/ui/ds/controls/radio_buttons.scss`
 * + `.../ds/buttons/_buttons.scss`'s `%base-button`/`%base-button-secondary`):
 * ONE rounded, `--color-background-tertiary`-filled wrapper (`$br-8` radius,
 * `gap: var(--sp-xs)`) with the option buttons INSIDE it, rather than a row of
 * individually-bordered, separately-backgrounded buttons (the previous
 * `GroupButtons` rendering, built on the generic `Button` primitive). Each
 * button is borderless and shares the wrapper's own background by default —
 * `%base-button-secondary`'s rest-state bg IS `--color-background-tertiary`,
 * the exact same token the wrapper itself uses — so unselected buttons
 * visually disappear into the pill; only the ACTIVE one stands out, via
 * `[aria-pressed="true"]`'s `--button-active-bg-color: var(--color-
 * background-quaternary)` + `--button-active-fg-color: var(--color-accent-
 * primary)` (teal icon/text on a slightly lighter chip) — cited verbatim
 * against `_buttons.scss`'s `%base-button-secondary` (its OWN active rule
 * fires from `_buttons.scss`'s shared `%base-button`).
 *
 * Deliberately NOT built on the existing `Button` primitive: `Button`'s own
 * variants (`primary`/`secondary`/`ghost`/`danger`/`icon`) each carry their
 * OWN border + always-visible background (see `Button.tsx`'s
 * `VARIANT_STYLE`), which is exactly the "separate bordered buttons" look
 * this component replaces — reusing `Button` here would mean fighting its
 * defaults with overrides rather than expressing the segmented-pill anatomy
 * directly. `Button`'s existing call sites (toolbar, dialogs, panel actions)
 * are UNTOUCHED — this is a new, additive primitive, not a `Button` variant.
 *
 * `--ccs-bg-tertiary`/`--ccs-bg-quaternary` (`tokens.css`) are this pass's
 * only new token additions — both are literal aliases of hex values already
 * present in `tokens.css` under other names (`--ccs-bg-tertiary` = the same
 * `#212426` as `--ccs-bg-input`; `--ccs-bg-quaternary` = the same `#2e3434`
 * as `--ccs-border`) confirmed against Penpot's own dark-theme
 * `--color-background-tertiary`/`--color-background-quaternary`
 * (`../penpot/frontend/src/app/main/ui/ds/colors.scss`) — kept as their own
 * named tokens rather than reusing `--ccs-bg-input`/`--ccs-border` directly
 * so this component's intent (Penpot's tertiary/quaternary SURFACE roles,
 * unrelated to "the color an `<input>` happens to use" or "the color a
 * BORDER happens to use") stays legible at the call site, even though today
 * the underlying hex is shared.
 */
export interface SegmentedGroupItem {
  value: string;
  content: React.ReactNode;
  active: boolean;
  disabled?: boolean;
  // `| undefined` explicit (not just `?:`) — `exactOptionalPropertyTypes`
  // rejects `Inspector.tsx`'s `GroupButtons` passing `ariaLabel: icon ?
  // preset.label : undefined` otherwise (a real, intentional "no aria-label"
  // branch, not omission of the prop).
  title?: string | undefined;
  ariaLabel?: string | undefined;
  onClick: () => void;
}

export interface SegmentedGroupProps {
  items: SegmentedGroupItem[];
  /** Penpot's `.extended` modifier (`radio_buttons.scss`) — each button
   * flex-grows to fill the wrapper's full width (a single full-width row,
   * e.g. Justify content) instead of a compact icon cluster.
   * `| undefined` explicit — `Inspector.tsx`'s `GroupButtons` forwards its
   * own opt-in `extended?: boolean` prop straight through, which under
   * `exactOptionalPropertyTypes` includes the `undefined` case (its
   * EXISTING, unchanged callers that never pass `extended` at all). */
  extended?: boolean | undefined;
  'aria-label'?: string | undefined;
}

export function SegmentedGroup({ items, extended, ...rest }: SegmentedGroupProps): React.ReactElement {
  return (
    <div
      role="group"
      aria-label={rest['aria-label']}
      className="ccs-segmented-group"
      style={{
        display: 'flex',
        alignItems: 'center',
        inlineSize: extended ? '100%' : 'fit-content',
        borderRadius: 'var(--ccs-radius)',
        background: 'var(--ccs-bg-tertiary)',
        gap: 'var(--ccs-space-1)',
        padding: 2,
      }}
    >
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={item.active}
          aria-label={item.ariaLabel}
          title={item.title}
          disabled={item.disabled}
          onClick={item.onClick}
          style={{
            all: 'unset',
            boxSizing: 'border-box',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: extended ? '1 1 0' : '0 0 auto',
            minInlineSize: 28,
            blockSize: 28,
            paddingInline: 6,
            borderRadius: 'calc(var(--ccs-radius) - 2px)',
            color: item.active ? 'var(--ccs-accent)' : 'var(--ccs-text-muted)',
            background: item.active ? 'var(--ccs-bg-quaternary)' : 'transparent',
            cursor: item.disabled ? 'not-allowed' : 'pointer',
            opacity: item.disabled ? 0.5 : 1,
          }}
        >
          {item.content}
        </button>
      ))}
    </div>
  );
}
