import './IOSDialogCard.css'

/**
 * IOSDialogCard — the shared iOS "liquid glass" alert surface.
 *
 * This is the visual primitive behind both the iOS `Dialog` and the iOS
 * `ActionSheet`: a frosted-glass card holding an optional title/description,
 * an optional content slot, and a column (or side-by-side pair) of pill
 * action buttons. It is an internal building block — not exported from the
 * package index — so the two public components stay visually identical.
 *
 * Each action is `{ label, onClick, primary, destructive }`:
 *  - `primary`     → aqua-filled button with white text
 *  - `destructive` → grey button with coral (warning) text
 *  - neither       → grey "secondary" button with default text
 *
 * `layout` controls the button arrangement:
 *  - "stacked"       → full-width buttons stacked vertically (default)
 *  - "side-by-side"  → two equal-width buttons in a row
 */

const IOSDialogButton = ({ label, onClick, primary, destructive, ...rest }) => (
  <button
    type="button"
    className={[
      'ios-dialog__btn',
      primary && 'ios-dialog__btn--primary',
      destructive && 'ios-dialog__btn--destructive',
    ].filter(Boolean).join(' ')}
    onClick={onClick}
    {...rest}
  >
    {label}
  </button>
)

export const IOSDialogCard = ({
  title,
  description,
  actions = [],
  layout = 'stacked',     // stacked | side-by-side
  children,               // optional slot rendered between the text and the actions
  className,
  ...props
}) => {
  const cls = ['ios-dialog', `ios-dialog--${layout}`, className].filter(Boolean).join(' ')
  return (
    <div className={cls} {...props}>
      <div className="ios-dialog__glass" aria-hidden="true" />
      <div className="ios-dialog__content">
        {(title || description) && (
          <div className="ios-dialog__text">
            {title && <p className="ios-dialog__title">{title}</p>}
            {description && <p className="ios-dialog__desc">{description}</p>}
          </div>
        )}
        {children && <div className="ios-dialog__slot">{children}</div>}
        {actions.length > 0 && (
          <div className="ios-dialog__actions">
            {actions.map((a, i) => (
              <IOSDialogButton key={i} {...a} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
