import { BottomSheet } from '../design-system'
import styles from './Sheet.module.css'

export default function Sheet() {
  return (
    <BottomSheet open platform="ios" size="fullscreen" title="Sheet" onClose={() => {}}>
      <div className={styles.content}>
        <p className={styles.blurb}>A whole step of a journey, without leaving the screen behind it. Replace this with its content.</p>
      </div>
      <div className={styles.content}>
        <p className={styles.blurb}>A whole step of a journey, without leaving the screen behind it. Replace this with its content.</p>
      </div>
    </BottomSheet>
  )
}
