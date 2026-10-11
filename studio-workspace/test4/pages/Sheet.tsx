import { BottomSheet } from '../design-system'
import styles from './Sheet.module.css'
import { useLanguage } from '../i18n/LanguageContext'

export default function Sheet() {
  const { t } = useLanguage()
  return (
    <BottomSheet open platform="ios" size="fullscreen" title={t.sheet.sheet} onClose={() => {}}>
      <div className={styles.content}>
        <p className={styles.blurb}>{t.sheet.aWholeStepOfA}</p>
      </div>
      <div className={styles.content}>
        <p className={styles.blurb}>{t.sheet.aWholeStepOfA}</p>
      </div>
    </BottomSheet>
  )
}
