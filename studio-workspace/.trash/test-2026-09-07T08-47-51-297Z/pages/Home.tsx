import styles from './Home.module.css'
import { useLanguage } from '../i18n/LanguageContext'
import { TabBar } from '@alm-design/design-system'

export default function Home() {
  const { t } = useLanguage()
  return (
    <main className={styles.page}>
      <h1 className={styles.title}>{t.home.home}</h1>
      <p className={styles.subtitle}>{t.home.startEditingThisPageIn}</p>
      <TabBar platform="ios" />
    </main>
  )
}
