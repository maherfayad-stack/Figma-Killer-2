import * as React from 'react';

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
  label?: string;
  options: SelectOption[];
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, options, style, id, ...rest },
  ref,
) {
  const autoId = React.useId();
  const selectId = id ?? autoId;
  return (
    <label
      className="ccs-field"
      htmlFor={selectId}
      style={{ display: 'flex', flexDirection: 'column', gap: 4, minInlineSize: 0 }}
    >
      {label && (
        <span style={{ fontSize: 'var(--ccs-font-size-xs)', color: 'var(--ccs-text-muted)' }}>{label}</span>
      )}
      <select
        ref={ref}
        id={selectId}
        style={{
          inlineSize: '100%',
          background: 'var(--ccs-bg-input)',
          color: 'var(--ccs-text)',
          border: '1px solid var(--ccs-border)',
          borderRadius: 'var(--ccs-radius-sm)',
          paddingInline: 8,
          paddingBlock: 5,
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
    </label>
  );
});
