import { BottomSheet } from '@alm-design/design-system'
import styles from './Sheet.module.css'

export default function Sheet() {
  return (
    <BottomSheet open platform="ios" size="small" title="Sheet" onClose={() => {}}>
      <div className={styles.content}>
        <p className={styles.blurb}>One question, or one thing to confirm. Replace this with what the sheet is for.</p>
      </div>
    </BottomSheet>
  )
}
