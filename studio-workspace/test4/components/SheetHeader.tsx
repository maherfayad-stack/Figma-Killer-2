import { GlassButton } from '@alm-design/design-system'
import IOSStatusBar from './IOSStatusBar'
import styles from './SheetHeader.module.css'
import { useLanguage } from '../i18n/LanguageContext'

/**
 * "Bottom sheet iOS 26" header — the status bar plus the sheet's back control.
 *
 * The leading button is deliberately a single unconditional `GlassButton
 * type="back"`: the design system draws its own chevron and mirrors it in
 * Arabic. An earlier version took an `icon` prop and picked the button with a
 * ternary, which the canvas cannot evaluate — it rendered the icon branch with
 * no icon, i.e. an empty circle. If a screen ever needs a different glyph, give
 * it its own header component rather than a branch here.
 */
export default function SheetHeader() {
  const { t } = useLanguage()
  return (
    <div className={styles.sheet}>
      <IOSStatusBar />
      <div className={styles.toolbar}>
        <span className={styles.back}>
          <GlassButton bg="default" type="back" aria-label={t.sheetHeader.back} />
        </span>
      </div>
    </div>
  )
}
