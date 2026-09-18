import './ActionSheet.css'
import { usePlatform, useDir } from '../context/DesignSystemContext'
import { IOSDialogCard } from './IOSDialogCard'
import { ChevronRightIcon, ChevronLeftIcon } from '../icons/LineIcons'

/**
 * ActionSheet — a contextual menu of actions, presented over the current
 * screen. Two platform presentations:
 *
 *  - platform="ios": the same liquid-glass card as the iOS Dialog (rendered
 *    by the shared `IOSDialogCard`) — an optional title/description above a
 *    stacked column of pill buttons. Pass actions as
 *    `[{ label, onClick, destructive }]`; mark the cancel/delete action
 *    `destructive` to colour it coral.
 *  - platform="android": a Material menu list — a rounded, elevated surface
 *    of rows. Pass `items` as
 *    `[{ icon, label, shortcut, chevron, onClick, destructive, disabled }]`.
 *
 * Platform follows the standard resolution: explicit `platform` prop >
 * <DesignSystemProvider> > "ios" default. Same for `dir`.
 *
 * Positioning mirrors `Dialog`: a fixed overlay with a tap-to-dismiss scrim
 * (dark on iOS, transparent on the Android menu).
 */

// Shared shell — overlay + dismiss scrim. Each platform mounts its surface inside.
const ActionSheetShell = ({ platform, dir, onClose, dismissOnScrim, children }) => (
  <div className={`action-sheet-overlay action-sheet-overlay--${platform}`} dir={dir}>
    <div
      className="action-sheet-overlay__scrim"
      aria-hidden="true"
      onClick={dismissOnScrim ? onClose : undefined}
    />
    {children}
  </div>
)

// Android-only internals — a Material menu list of rows.
const ActionSheetAndroid = ({ items, dir, className, ...props }) => {
  // The submenu chevron points toward the trailing edge, so it mirrors in RTL.
  const Chevron = dir === 'rtl' ? ChevronLeftIcon : ChevronRightIcon
  return (
    <div
      className={['action-sheet', 'action-sheet--android', className].filter(Boolean).join(' ')}
      role="menu"
      {...props}
    >
      {items.map((item, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          className={[
            'action-sheet__item',
            item.destructive && 'action-sheet__item--destructive',
          ].filter(Boolean).join(' ')}
          onClick={item.onClick}
          disabled={item.disabled}
        >
          {item.icon && <span className="action-sheet__item-icon">{item.icon}</span>}
          <span className="action-sheet__item-label">{item.label}</span>
          {item.shortcut && <span className="action-sheet__item-shortcut">{item.shortcut}</span>}
          {item.chevron && <span className="action-sheet__item-chevron"><Chevron /></span>}
        </button>
      ))}
    </div>
  )
}

export const ActionSheet = ({
  platform,               // ios | android — falls back to provider, then "ios"
  title,                  // iOS only
  description,            // iOS only
  actions = [],           // iOS — [{ label, onClick, destructive }]
  items = [],             // android — [{ icon, label, shortcut, chevron, onClick, destructive, disabled }]
  onClose,                // called when the scrim is tapped
  dismissOnScrim = true,
  dir,                    // ltr | rtl — falls back to provider, then "ltr"
  className,
  children,               // optional iOS content slot (between text and actions)
  ...props
}) => {
  const resolvedPlatform = usePlatform(platform)
  const resolvedDir = useDir(dir)

  return (
    <ActionSheetShell
      platform={resolvedPlatform}
      dir={resolvedDir}
      onClose={onClose}
      dismissOnScrim={dismissOnScrim}
    >
      {resolvedPlatform === 'ios' ? (
        <IOSDialogCard
          role="dialog"
          aria-modal="true"
          title={title}
          description={description}
          actions={actions}
          className={['action-sheet', 'action-sheet--ios', className].filter(Boolean).join(' ')}
          {...props}
        >
          {children}
        </IOSDialogCard>
      ) : (
        <ActionSheetAndroid items={items} dir={resolvedDir} className={className} {...props} />
      )}
    </ActionSheetShell>
  )
}
