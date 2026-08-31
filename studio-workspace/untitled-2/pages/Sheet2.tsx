import { BottomSheet } from '@alm-design/design-system'
import styles from './Sheet2.module.css'

export default function Sheet2() {
  return (
    <BottomSheet open platform="ios" size="fullscreen" title="Sheet2" onClose={() => {}}>
      <div className={styles.content}>
        <p className={styles.blurb}>A whole step of a journey, without leaving the screen behind it. Replace this with its content.</p>
      </div>
    </BottomSheet>
  )
}
