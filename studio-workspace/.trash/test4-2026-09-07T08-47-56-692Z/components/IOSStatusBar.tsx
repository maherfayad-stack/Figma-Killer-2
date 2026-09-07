import batterySvg from '../assets/71e049cc-f8f7-435e-9eb9-1635d2ca2d4d.svg?raw'
import cellularSvg from '../assets/f042ca30-2853-4d87-83c4-d56730fb0cdd.svg?raw'
import wifiSvg from '../assets/04e2e2ec-5b67-4b87-87c2-a3b76d5aed9f.svg?raw'
import styles from './IOSStatusBar.module.css'

export default function IOSStatusBar() {
  return (
    <div className={styles.statusBar}>
      <span className={styles.time}>9:41</span>
      <span className={styles.islandSpacer} />
      <span className={styles.island} />
      <span className={styles.levels}>
        <span className={styles.cellular} dangerouslySetInnerHTML={{ __html: cellularSvg }} />
        <span className={styles.wifi} dangerouslySetInnerHTML={{ __html: wifiSvg }} />
        <span className={styles.battery} dangerouslySetInnerHTML={{ __html: batterySvg }} />
      </span>
    </div>
  )
}
