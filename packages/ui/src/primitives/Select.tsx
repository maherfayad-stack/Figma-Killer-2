import * as React from 'react';
import { Icon, type IconName } from '../icons/Icon.js';

/**
 * Select — a native `<select>` styled to match the chrome tokens.
 *
 * CR (flagged, not silently decided): the playbook/task brief describes
 * "Radix/shadcn-style primitives". This package deliberately does NOT take
 * a runtime dependency on `@radix-ui/*` (not in the workspace catalog —
 * ADR-0001..0004 discipline is "verify + pin deliberately", not add a new
 * dependency family inside a single medium-effort P5 pass). Every primitive
 * here instead reproduces Radix's *contract* (composable, unstyled-first,
 * fully keyboard/ARIA accessible) with plain React + the chrome tokens.
 * `Select` specifically keeps the NATIVE `<select>` element (native
 * listbox a11y/keyboard/mobile support for free) rather than hand-rolling a
 * custom popover listbox — swap for `@radix-ui/react-select` later if the
 * product needs multi-line/rich option rendering Radix would justify.
 */
export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  // FIX-W4b-5: explicit `| undefined` (not just `label?:`) — under this
  // repo's `exactOptionalPropertyTypes`, `label?: string` alone rejects a
  // call site that passes `label={compact ? undefined : label}` (a real,
  // intentional "no label" case, e.g. `Inspector.tsx`'s `GroupSelect`
  // `compact` mode), not just omission of the prop entirely.
  label?: string | undefined;
  options: SelectOption[];
  /** FIX-W4b-2: a leading glyph INSIDE the field, matching `Input`'s own
   * `leadingIcon` (see that file's doc) — used where a Penpot measures
   * control (e.g. corner radius) is a preset dropdown in this tool rather
   * than Penpot's free-numeric input, but should still carry the same
   * property glyph. Purely additive/optional. */
  leadingIcon?: IconName | undefined;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, options, leadingIcon, style, id, 'aria-label': ariaLabelProp, ...rest },
  ref,
) {
  const autoId = React.useId();
  const selectId = id ?? autoId;
  // FIX-W4b-9b: an explicit caller-supplied `aria-label` (e.g. `Inspector.
  // tsx`'s `GroupSelect` `compact` mode) always wins; otherwise, when
  // `leadingIcon` hides the visible label span below, fall back to `label`
  // as the accessible name so a11y is never silently dropped.
  const ariaLabel = ariaLabelProp ?? (leadingIcon ? label : undefined);
  return (
    <label
      className="ccs-field"
      htmlFor={selectId}
      style={{ display: 'flex', flexDirection: 'column', gap: 4, minInlineSize: 0 }}
    >
      {label && !leadingIcon && (
        <span style={{ fontSize: 'var(--ccs-font-size-xs)', color: 'var(--ccs-text-muted)' }}>{label}</span>
      )}
      <span style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <select
          ref={ref}
          id={selectId}
          aria-label={ariaLabel}
          style={{
            inlineSize: '100%',
            background: 'var(--ccs-bg-input)',
            color: 'var(--ccs-text)',
            border: '1px solid var(--ccs-border)',
            // FIX-W4b-5: Penpot's `$br-8` standard control radius (was the
            // smaller `--ccs-radius-sm`) + explicit 32px row height (was an
            // unfixed ~26px `paddingBlock: 5`) — see `Input.tsx`'s matching
            // fix for the full citation (`ds/_borders.scss`/`_buttons.scss`).
            borderRadius: 'var(--ccs-radius)',
            blockSize: 'var(--ccs-row-height)',
            paddingInlineStart: leadingIcon ? 26 : 8,
            paddingInlineEnd: 8,
            fontSize: 'var(--ccs-font-size-sm)',
            fontFamily: 'inherit',
            ...style,
          }}
          {...rest}
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {leadingIcon && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              insetInlineStart: 8,
              display: 'flex',
              alignItems: 'center',
              color: 'var(--ccs-text-subtle)',
              pointerEvents: 'none',
            }}
          >
            <Icon name={leadingIcon} size={12} />
          </span>
        )}
      </span>
    </label>
  );
});
