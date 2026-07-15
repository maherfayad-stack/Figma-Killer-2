import * as React from 'react';

/**
 * Button — the studio chrome's base action control (playbook §2, ADR-0007
 * Penpot-grade look). Deliberately plain (no Radix `Slot`/`asChild` — see
 * package README CR note): a `<button>` wrapper is all every call site in
 * `apps/studio` needs, and it keeps the primitive trivially testable.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'icon';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  active?: boolean;
}

const VARIANT_STYLE: Record<ButtonVariant, React.CSSProperties> = {
  primary: { background: 'var(--ccs-accent)', color: 'var(--ccs-accent-contrast)', borderColor: 'transparent' },
  secondary: { background: 'var(--ccs-bg-panel-raised)', color: 'var(--ccs-text)', borderColor: 'var(--ccs-border)' },
  ghost: { background: 'transparent', color: 'var(--ccs-text)', borderColor: 'transparent' },
  danger: { background: 'transparent', color: 'var(--ccs-text-danger)', borderColor: 'var(--ccs-border)' },
  icon: { background: 'transparent', color: 'var(--ccs-text-muted)', borderColor: 'transparent' },
};

const SIZE_STYLE: Record<ButtonSize, React.CSSProperties> = {
  sm: { paddingBlock: 4, paddingInline: 8, fontSize: 'var(--ccs-font-size-sm)' },
  md: { paddingBlock: 6, paddingInline: 12, fontSize: 'var(--ccs-font-size-md)' },
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', active, style, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      data-ccs-variant={variant}
      aria-pressed={active}
      className={['ccs-btn', className].filter(Boolean).join(' ')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        borderWidth: 1,
        borderStyle: 'solid',
        borderRadius: 'var(--ccs-radius-md)',
        fontFamily: 'inherit',
        fontWeight: 500,
        cursor: rest.disabled ? 'not-allowed' : 'pointer',
        opacity: rest.disabled ? 0.5 : 1,
        transition: 'background-color 120ms ease, border-color 120ms ease',
        ...VARIANT_STYLE[variant],
        ...SIZE_STYLE[size],
        ...(active ? { background: 'var(--ccs-bg-active)', borderColor: 'var(--ccs-accent)' } : null),
        ...style,
      }}
      {...rest}
    />
  );
});
