import * as React from 'react';
import { Icon, type IconName } from '../icons/Icon.js';

/**
 * Input / NumberField — token-aware inspector inputs (playbook §2.3
 * `input_wrapper_tokens.cljs` pattern). `trailing` renders a slot on the
 * LOGICAL end (not physical right) — in `dir="rtl"` this correctly flips to
 * the visual left, which is exactly how a token-picker toggle button should
 * behave next to a color/size field.
 */
export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  trailing?: React.ReactNode;
  /** Renders a small token chip instead of the raw value when this field is
   * bound to a design token (playbook §2.3 token-aware inputs). */
  tokenBinding?: { name: string; value: string } | null;
  /** FIX-W4b-2: a leading glyph INSIDE the field, at the LOGICAL start —
   * Penpot's own `numeric-input-wrapper*` puts a property glyph (`character-w`
   * /`character-h`/`character-x`/`character-y`/`corner-radius`/...) here for
   * every measures/layout numeric field (see `measures.cljs`). Purely
   * additive/optional: omitted at every pre-existing call site, so those
   * render byte-identical to before. */
  leadingIcon?: IconName | undefined;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, trailing, tokenBinding, leadingIcon, style, className, id, ...rest },
  ref,
) {
  const autoId = React.useId();
  const inputId = id ?? autoId;
  return (
    <label
      className={['ccs-field', className].filter(Boolean).join(' ')}
      htmlFor={inputId}
      style={{ display: 'flex', flexDirection: 'column', gap: 4, minInlineSize: 0 }}
    >
      {label && (
        <span style={{ fontSize: 'var(--ccs-font-size-xs)', color: 'var(--ccs-text-muted)' }}>{label}</span>
      )}
      <span style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        {tokenBinding ? (
          <span
            data-testid="token-chip"
            title={`${tokenBinding.name}: ${tokenBinding.value}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              paddingInline: 8,
              paddingBlock: 5,
              borderRadius: 'var(--ccs-radius-sm)',
              background: 'var(--ccs-bg-input)',
              border: '1px solid var(--ccs-border)',
              fontSize: 'var(--ccs-font-size-sm)',
              insetInlineEnd: trailing ? 24 : 0,
              flex: 1,
            }}
          >
            <span
              aria-hidden
              style={{ inlineSize: 10, blockSize: 10, borderRadius: 2, background: tokenBinding.value, flexShrink: 0 }}
            />
            {tokenBinding.name}
          </span>
        ) : (
          <input
            ref={ref}
            id={inputId}
            className="ccs-input"
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
              paddingInlineStart: leadingIcon ? 26 : 8,
              paddingInlineEnd: trailing ? 24 : 8,
              ...style,
            }}
            {...rest}
          />
        )}
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
        {trailing && (
          <span style={{ position: 'absolute', insetInlineEnd: 4, display: 'flex', alignItems: 'center' }}>
            {trailing}
          </span>
        )}
      </span>
    </label>
  );
});
