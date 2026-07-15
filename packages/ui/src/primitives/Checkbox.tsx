import * as React from 'react';

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, id, style, ...rest },
  ref,
) {
  const autoId = React.useId();
  const checkboxId = id ?? autoId;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <input
        ref={ref}
        type="checkbox"
        id={checkboxId}
        style={{ inlineSize: 14, blockSize: 14, accentColor: 'var(--ccs-accent)', ...style }}
        {...rest}
      />
      {label && (
        <label htmlFor={checkboxId} style={{ fontSize: 'var(--ccs-font-size-sm)', color: 'var(--ccs-text)' }}>
          {label}
        </label>
      )}
    </span>
  );
});
