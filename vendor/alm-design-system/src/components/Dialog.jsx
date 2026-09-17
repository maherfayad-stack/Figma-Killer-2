import './Dialog.css'
import { usePlatform, useDir } from '../context/DesignSystemContext'
import { IOSDialogCard } from './IOSDialogCard'

/**
 * Dialog — modal window that appears in front of app content to provide
 * critical information or ask for a decision. Two platform presentations:
 *
 *  - platform="android": Material "list" dialog — rounded surface, optional
 *    icon, centered title + description, optional slot, text actions row.
 *  - platform="ios": native "basic" dialog — frosted liquid-glass card,
 *    start-aligned title + description, an optional content slot, and pill
 *    action buttons. Buttons stack by default; pass `layout="side-by-side"`
 *    for two equal-width buttons in a row. Rendered by the shared
 *    `IOSDialogCard` (the same surface as the iOS ActionSheet).
 *
 * Platform follows the standard resolution: explicit `platform` prop >
 * <DesignSystemProvider> > "ios" default. Same for `dir`.
 *
 * Actions are passed as an array; each `{ label, onClick, primary, destructive }`.
 *  - `primary`     → aqua-filled button with white text (iOS)
 *  - `destructive` → coral (warning) text
 */

// Shared shell — owns the overlay, scrim + dismiss logic, and dialog a11y.
// Both platform renders mount inside it so this markup is never duplicated.
const DialogShell = ({ dir, onClose, dismissOnScrim, children }) => (
  <div className="dialog-overlay" dir={dir}>
    <div
      className="dialog-overlay__scrim"
      aria-hidden="true"
      onClick={dismissOnScrim ? onClose : undefined}
    />
    {children}
  </div>
)

// Android-only internals — rounded surface, optional icon + slot, text actions.
const DialogAndroid = ({ title, description, icon, actions, children, className, ...props }) => (
  <div
    className={['dialog', 'dialog--android', className].filter(Boolean).join(' ')}
    role="dialog"
    aria-modal="true"
    {...props}
  >
    <div className="dialog__content">
      {icon && <div className="dialog__icon">{icon}</div>}
      {title && <p className="dialog__title">{title}</p>}
      {description && <p className="dialog__desc">{description}</p>}
      {children && <div className="dialog__slot">{children}</div>}
    </div>
    {actions.length > 0 && (
      <div className="dialog__actions">
        {actions.map((a, i) => (
          <button
            key={i}
            type="button"
            className={[
              'dialog__action',
              a.destructive && 'dialog__action--destructive',
            ].filter(Boolean).join(' ')}
            onClick={a.onClick}
          >
            {a.label}
          </button>
        ))}
      </div>
    )}
  </div>
)

export const Dialog = ({
  platform,               // ios | android — falls back to provider, then "ios"
  title,
  description,
  icon,                   // ReactNode — shown above the title (android only)
  layout = 'stacked',     // stacked | side-by-side — iOS button arrangement

  // iOS actions — named by role; each is { label, onClick }. Presence renders
  // the button. Stacked order: primary, destructive, secondary.
  primaryAction,          // aqua-filled button
  destructiveAction,      // coral text button (stacked only)
  secondaryAction,        // grey button

  // Android actions — each is { label, onClick, destructive }. action1 is the
  // confirming action and sits at the trailing edge.
  action1,
  action2,

  onClose,                // called when the scrim is tapped
  dismissOnScrim = true,
  dir,                    // ltr | rtl — falls back to provider, then "ltr"
  className,
  children,               // optional slot content (android, or iOS content slot)
  ...props
}) => {
  const resolvedPlatform = usePlatform(platform)
  const resolvedDir = useDir(dir)

  if (resolvedPlatform === 'ios') {
    // Build the ordered button list from the role-named props.
    const actions = layout === 'side-by-side'
      ? [
          secondaryAction && { ...secondaryAction },
          primaryAction && { ...primaryAction, primary: true },
        ]
      : [
          primaryAction && { ...primaryAction, primary: true },
          destructiveAction && { ...destructiveAction, destructive: true },
          secondaryAction && { ...secondaryAction },
        ]

    return (
      <DialogShell dir={resolvedDir} onClose={onClose} dismissOnScrim={dismissOnScrim}>
        <IOSDialogCard
          role="dialog"
          aria-modal="true"
          title={title}
          description={description}
          actions={actions.filter(Boolean)}
          layout={layout}
          className={['dialog', 'dialog--ios', className].filter(Boolean).join(' ')}
          {...props}
        >
          {children}
        </IOSDialogCard>
      </DialogShell>
    )
  }

  // Android — action1 (confirming) sits at the trailing edge, so render action2 first.
  const androidActions = [action2, action1].filter(Boolean)
  return (
    <DialogShell dir={resolvedDir} onClose={onClose} dismissOnScrim={dismissOnScrim}>
      <DialogAndroid
        title={title}
        description={description}
        icon={icon}
        actions={androidActions}
        className={className}
        {...props}
      >
        {children}
      </DialogAndroid>
    </DialogShell>
  )
}
