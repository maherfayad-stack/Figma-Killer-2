import './BottomSheet.css'
import { usePlatform, useDir } from '../context/DesignSystemContext'
import { GlassButton } from './GlassButton'
import arrowLeftRaw from '../icons/line-icons/arrowLeft.svg?raw'
import arrowRightRaw from '../icons/line-icons/arrowRight.svg?raw'
import xRaw from '../icons/line-icons/x.svg?raw'

// design-system line icon — currentColor tints it via the icon-* tokens
const RawIcon = ({ svg }) => (
  <span className="bottom-sheet__icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
)

const Grabber = () => (
  <div className="bottom-sheet__grabber-row" aria-hidden="true">
    <div className="bottom-sheet__grabber" />
  </div>
)

// Shared centred title/subtitle — absolutely positioned so it ignores button widths.
const ToolbarTitle = ({ title, subtitle }) =>
  (title || subtitle) && (
    <div className="bottom-sheet__title">
      {title && <span className="bottom-sheet__title-text">{title}</span>}
      {subtitle && <span className="bottom-sheet__subtitle-text">{subtitle}</span>}
    </div>
  )

// iOS toolbar — the shared _Toolbar-IOS: glass close (left), centred title, aqua action (right).
const ToolbarIos = ({ title, subtitle, onClose, onAction, actionIcon, dir }) => (
  <div className="bottom-sheet__toolbar bottom-sheet__toolbar--ios">
    <div className="bottom-sheet__toolbar-lhs">
      {onClose && (
        <GlassButton bg="default" type="x" onClick={onClose} dir={dir} aria-label="Close" />
      )}
    </div>
    <ToolbarTitle title={title} subtitle={subtitle} />
    <div className="bottom-sheet__toolbar-rhs">
      {onAction && (
        <GlassButton bg="primary" type="1-icon" icon1={actionIcon} onClick={onAction} dir={dir} aria-label="Action" />
      )}
    </div>
  </div>
)

// Android fullscreen toolbar (_Toolbar-Android): back arrow (RTL-mirrored), centred
// title/subtitle, trailing action — aqua-tinted material icon buttons.
const ToolbarAndroid = ({ title, subtitle, onClose, onAction, actionIcon, dir }) => (
  <div className="bottom-sheet__toolbar bottom-sheet__toolbar--android">
    <div className="bottom-sheet__toolbar-lhs">
      {onClose && (
        <button type="button" className="bottom-sheet__icon-btn" onClick={onClose} aria-label="Back">
          <RawIcon svg={dir === 'rtl' ? arrowRightRaw : arrowLeftRaw} />
        </button>
      )}
    </div>
    <ToolbarTitle title={title} subtitle={subtitle} />
    <div className="bottom-sheet__toolbar-rhs">
      {onAction && (
        <button type="button" className="bottom-sheet__icon-btn" onClick={onAction} aria-label="Action">
          <span className="bottom-sheet__icon">{actionIcon}</span>
        </button>
      )}
    </div>
  </div>
)

// Shared shell — owns the wrapper class, scrim, and dialog a11y.
const BottomSheetShell = ({ platform, size, open, dir, className, onClose, children, ...props }) => {
  const cls = [
    'bottom-sheet',
    `bottom-sheet--${platform}`,
    `bottom-sheet--${size}`,
    open && 'bottom-sheet--open',
    className,
  ].filter(Boolean).join(' ')

  return (
    <div className={cls} dir={dir} role="dialog" aria-modal="true" {...props}>
      <div className="bottom-sheet__frame">
        {/* scrim dims the presenting screen (incl. its status bar) behind the sheet */}
        <div className="bottom-sheet__scrim" aria-hidden="true" onClick={onClose} />
        <div className="bottom-sheet__panel">{children}</div>
      </div>
    </div>
  )
}

// iOS-only internals — grabber on medium/small; fullscreen drops the grabber and
// shows the toolbar (+ optional search). The device status bar is the host screen's,
// not the sheet's — the panel starts below it via --bottom-sheet-top-inset.
const BottomSheetIOS = ({ size, search, toolbar, children }) => {
  if (size === 'fullscreen') {
    return (
      <>
        <div className="bottom-sheet__header">
          {toolbar}
          {search && <div className="bottom-sheet__search-bar">{search}</div>}
        </div>
        <div className="bottom-sheet__content">{children}</div>
      </>
    )
  }
  return (
    <>
      <Grabber />
      {toolbar}
      <div className="bottom-sheet__content">{children}</div>
    </>
  )
}

// Android-only internals. fullscreen: back-arrow toolbar + optional search.
// medium: a drag handle, then a row of leading close (×) · left-aligned title ·
// trailing action — not the centred toolbar (Figma 53597-6714).
const BottomSheetAndroid = ({ size, toolbar, search, title, onClose, onAction, actionIcon, children }) => {
  if (size === 'fullscreen') {
    return (
      <>
        <div className="bottom-sheet__header">
          {toolbar}
          {search && <div className="bottom-sheet__search-bar">{search}</div>}
        </div>
        <div className="bottom-sheet__content">{children}</div>
      </>
    )
  }
  return (
    <>
      <Grabber />
      <div className="bottom-sheet__android-bar">
        {onClose && (
          <button type="button" className="bottom-sheet__icon-btn" onClick={onClose} aria-label="Close">
            <RawIcon svg={xRaw} />
          </button>
        )}
        {title && <p className="bottom-sheet__android-title">{title}</p>}
        {onAction && (
          <button type="button" className="bottom-sheet__icon-btn" onClick={onAction} aria-label="Action">
            <span className="bottom-sheet__icon">{actionIcon}</span>
          </button>
        )}
      </div>
      <div className="bottom-sheet__content">{children}</div>
    </>
  )
}

export const BottomSheet = ({
  open = false,
  size: sizeProp = 'medium', // fullscreen | medium | small (small is iOS-only)
  platform,               // ios | android — falls back to provider, then "ios"
  title,
  subtitle,
  onClose,
  onAction,
  actionIcon,
  search,                 // React node — injected below toolbar in ios fullscreen
  dir,                    // ltr | rtl — falls back to provider, then "ltr"
  className,
  children,
  ...props
}) => {
  const resolvedPlatform = usePlatform(platform)
  const resolvedDir = useDir(dir)
  // Android only has fullscreen + medium; `small` is iOS-only, so clamp it.
  const size = resolvedPlatform === 'android' && sizeProp === 'small' ? 'medium' : sizeProp

  const toolbar = resolvedPlatform === 'ios' ? (
    <ToolbarIos
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      onAction={onAction}
      actionIcon={actionIcon}
      dir={resolvedDir}
    />
  ) : (
    <ToolbarAndroid
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      onAction={onAction}
      actionIcon={actionIcon}
      dir={resolvedDir}
    />
  )

  return (
    <BottomSheetShell
      platform={resolvedPlatform}
      size={size}
      open={open}
      dir={resolvedDir}
      className={className}
      onClose={onClose}
      {...props}
    >
      {resolvedPlatform === 'ios' ? (
        <BottomSheetIOS size={size} search={search} toolbar={toolbar}>
          {children}
        </BottomSheetIOS>
      ) : (
        <BottomSheetAndroid
          size={size}
          toolbar={toolbar}
          search={search}
          title={title}
          onClose={onClose}
          onAction={onAction}
          actionIcon={actionIcon}
        >
          {children}
        </BottomSheetAndroid>
      )}
    </BottomSheetShell>
  )
}
