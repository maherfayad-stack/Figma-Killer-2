import { BottomSheet } from '@alm-design/design-system'
import styles from './Sheet.module.css'
import { useLanguage } from '../i18n/LanguageContext'

export default function Sheet() {
  const { t } = useLanguage()
  return (
    <BottomSheet open platform="ios" size="small" title={t.sheet.sheet} onClose={() => {}}>
      <div className={styles.content}>
        <p className={styles.blurb}>{t.sheet.oneQuestionOrOneThing}</p>
      </div>
    </BottomSheet>
  )
}
