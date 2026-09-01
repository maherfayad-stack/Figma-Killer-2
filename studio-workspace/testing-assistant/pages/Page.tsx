import styles from './Page.module.css'
import { TabBar } from '@alm-design/design-system'

export default function Page() {
  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Page</h1>
      <p className={styles.subtitle}>Start editing this page in Studio.</p>
      <TabBar platform="ios" />
    </main>
  )
}
