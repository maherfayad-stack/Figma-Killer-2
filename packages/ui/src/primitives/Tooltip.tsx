import * as React from 'react';

/**
 * Tooltip — hover/focus label (e.g. toolbar icon-button hints). Positioned
 * with logical `inset-inline-start: 50%` + a translate, so it stays
 * centered under the anchor in both writing directions without a
 * direction-specific branch.
 */
export interface TooltipProps {
  label: string;
  children: React.ReactElement<{ 'aria-describedby'?: string | undefined }>;
}

export function Tooltip({ label, children }: TooltipProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();

  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {React.cloneElement(children, { 'aria-describedby': open ? id : undefined })}
      {open && (
        <span
          role="tooltip"
          id={id}
          style={{
            position: 'absolute',
            insetBlockStart: '100%',
            insetInlineStart: '50%',
            transform: 'translateX(-50%) translateY(4px)',
            background: 'var(--ccs-bg-overlay)',
            color: 'var(--ccs-text)',
            border: '1px solid var(--ccs-border-strong)',
            borderRadius: 'var(--ccs-radius-sm)',
            paddingInline: 8,
            paddingBlock: 4,
            fontSize: 'var(--ccs-font-size-xs)',
            whiteSpace: 'nowrap',
            zIndex: 1000,
            boxShadow: 'var(--ccs-shadow-overlay)',
            pointerEvents: 'none',
          }}
        >
          {label}
        </span>
      )}
    </span>
  );
}
