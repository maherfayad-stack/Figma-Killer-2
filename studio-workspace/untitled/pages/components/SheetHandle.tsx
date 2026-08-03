import styles from './SheetHandle.module.css'

export function SheetHandle() {
  return (
    <div className={styles.wrap} aria-hidden="true">
      <div className={styles.statusBar}>
        <span className={styles.time}>9:41</span>
        <span className={styles.island} />
        <span className={styles.icons}>
          <svg width="18" height="12" viewBox="0 0 18 12"><g fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="6" width="3" height="6" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></g></svg>
          <svg width="16" height="12" viewBox="0 0 16 12"><path fill="currentColor" d="M8 2.5c2.05 0 3.98.75 5.48 2.05l1.35-1.35A9.5 9.5 0 0 0 8 0a9.5 9.5 0 0 0-6.83 3.2L2.52 4.55A7.53 7.53 0 0 1 8 2.5zm0 3.75c1.1 0 2.13.4 2.92 1.08l1.35-1.35A6.5 6.5 0 0 0 8 4.25a6.5 6.5 0 0 0-4.27 1.58L5.08 7.18A4.5 4.5 0 0 1 8 6.25zm0 3.75a2.25 2.25 0 0 0-1.59.66L8 12l1.59-1.34A2.25 2.25 0 0 0 8 10z"/></svg>
          <svg width="26" height="12" viewBox="0 0 26 12"><rect x="0.5" y="0.5" width="22" height="11" rx="3" fill="none" stroke="currentColor"/><rect x="23.5" y="4" width="1.5" height="4" rx="0.5" fill="currentColor"/><rect x="2" y="2" width="19" height="8" rx="1.5" fill="currentColor"/></svg>
        </span>
      </div>
      <div className={styles.sheetTop} />
    </div>
  )
}
