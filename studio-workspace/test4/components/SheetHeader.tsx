import { GlassButton } from '@alm-design/design-system'
import IOSStatusBar from './IOSStatusBar'
import styles from './SheetHeader.module.css'
import { useLanguage } from '../i18n/LanguageContext'

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
