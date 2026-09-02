import styles from './CssProbe.module.css'
import { useLanguage } from '../i18n/LanguageContext'

export default function CssProbe() {
  const { t } = useLanguage()
  return <main className={styles.probe}>{t.cssProbe.probe}
      <p>{t.cssProbe.addYourTextHere}</p>
  </main>
}
