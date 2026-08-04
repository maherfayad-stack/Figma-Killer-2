import type { ReactNode } from 'react'
import { GlassButton } from '@alm-design/design-system'
import '@alm-design/design-system/dist/index.css'
import styles from './Screen.module.css'

type ScreenProps = {
  children: ReactNode
  showBack?: boolean
}

export function Screen({ children, showBack = true }: ScreenProps) {
  return (
    <div className={styles.screen}>
      <div className={styles.statusBar}>
        <div className={styles.time}>9:41</div>
        <div className={styles.island} />
        <div className={styles.indicators}>
          <span className={styles.dots}>••••</span>
          <span className={styles.wifi}>▲</span>
          <span className={styles.battery} />
        </div>
      </div>
      <div className={styles.toolbar}>
        {showBack ? (
          <div className={styles.back}>
            <GlassButton type="back" aria-label="Back" />
          </div>
        ) : null}
      </div>
      <div className={styles.content}>{children}</div>
    </div>
  )
}
