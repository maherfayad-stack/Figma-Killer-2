import styles from './Home.module.css'
import { TabBar, Callout, LinearProgressIndicator, Search } from '@alm-design/design-system'

export default function Home() {
  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Home</h1>
      <TabBar platform="ios" />
      <TabBar platform="ios" />
      <Search label="asd" platform="ios" showClose={false} placeholder="asdasdasd" value="asdasdasdasd" />
      <LinearProgressIndicator platform="ios" />
      <p className={styles.subtitle}>Start editing this page in Studio.</p>
      <Callout label="Callout" size="regular" />
      <TabBar platform="ios" />
    </main>
  )
}
