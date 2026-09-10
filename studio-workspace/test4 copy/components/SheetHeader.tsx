import { GlassButton } from '@alm-design/design-system'
import IOSStatusBar from './IOSStatusBar'
import styles from './SheetHeader.module.css'
import { useLanguage } from '../i18n/LanguageContext'

/** Which control sits at the leading edge of the toolbar, if any. */
export type SheetHeaderLeading = 'back' | 'close' | 'none'

/**
 * `large` heads a sheet that covers the screen: it carries the iOS status bar
 * and the scrim behind it. `small` heads a sheet that floats over the page:
 * a grabber instead, and no status bar to scrim.
 */
export type SheetHeaderSize = 'large' | 'small'

interface SheetHeaderProps {
  size?: SheetHeaderSize
  leading?: SheetHeaderLeading
  /** Shown centred in the toolbar. Omit for a sheet whose title lives in its content instead. */
  title?: string
}

/**
 * The top of a bottom sheet: status bar or grabber, then a toolbar carrying an
 * optional back/close control and an optional centred title.
 *
 * The toolbar is a three-column grid — leading control, title, trailing spacer
 * — rather than a relative box with an absolutely-positioned button. That is
 * what makes it right in Arabic: grid columns follow the writing direction on
 * their own, so the control moves to the other edge with no RTL rule to write
 * and none to forget. The empty trailing cell exists so the title stays
 * centred on the SHEET rather than on the space left over beside the button.
 *
 * `dir` is passed to `GlassButton` explicitly from this app's own language
 * rather than left to the design system's ambient default, which is `ltr`
 * whenever no `<DesignSystemProvider>` is mounted — and this app mounts none.
 * Without it the back chevron points the wrong way in Arabic no matter which
 * way the layout runs.
 *
 * The size variant rides on `data-size`, not on a computed `className`. A
 * className built from a template literal is not a literal Studio can read, so
 * the element would arrive on the canvas with no classes attached and nothing
 * to edit in the panel; an attribute keeps `styles.sheet` a plain literal and
 * still gives the stylesheet everything it needs to branch on.
 */
export default function SheetHeader({ size = 'large', leading = 'back', title }: SheetHeaderProps) {
  const { t, dir } = useLanguage()
  return (
    <div className={styles.sheet} data-size={size}>
      {size === 'large' ? (
        <>
          <span className={styles.scrim} aria-hidden="true" />
          <IOSStatusBar />
        </>
      ) : (
        <div className={styles.grabberRow}>
          <span className={styles.grabber} />
        </div>
      )}
      <div className={styles.toolbar}>
        <span className={styles.leading}>
          {leading !== 'none' && (
            <GlassButton
              bg="default"
              type={leading === 'back' ? 'back' : 'x'}
              dir={dir}
              aria-label={leading === 'back' ? t.sheetHeader.back : t.sheetHeader.close}
            />
          )}
        </span>
        {title ? <span className={styles.title}>{title}</span> : null}
        <span className={styles.trailing} aria-hidden="true" />
      </div>
    </div>
  )
}
