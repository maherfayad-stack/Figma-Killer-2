import type { ButtonHTMLAttributes } from 'react';
import './Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'destructive';
export type ButtonSize = 'default' | 'medium' | 'small';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Text is set via `label`, mirroring the real DS Button — it does not render `children`. */
  label: string;
  className?: string;
}

// Factored out of the component so it's independently unit-testable
// without rendering (mirrors the real DS's inline `cls` builder, e.g.
// design-system/src/components/Button.jsx).
export function buildButtonClassName(variant: ButtonVariant, size: ButtonSize, className?: string): string {
  return ['btn', `btn--${variant}`, `btn--size-${size}`, className].filter(Boolean).join(' ');
}

export function Button({ variant = 'primary', size = 'default', label, className, ...props }: ButtonProps) {
  return (
    <button className={buildButtonClassName(variant, size, className)} type="button" {...props}>
      {label}
    </button>
  );
}
