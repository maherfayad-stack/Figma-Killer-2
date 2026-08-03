import styles from './OtpInput.module.css'

export function OtpInput() {
  return (
    <div className={styles.row} role="group" aria-label="Verification code">
      <input className={styles.cell} type="text" inputMode="numeric" maxLength={1} aria-label="Digit 1" />
      <input className={styles.cell} type="text" inputMode="numeric" maxLength={1} aria-label="Digit 2" />
      <input className={styles.cell} type="text" inputMode="numeric" maxLength={1} aria-label="Digit 3" />
      <input className={styles.cell} type="text" inputMode="numeric" maxLength={1} aria-label="Digit 4" />
      <input className={styles.cell} type="text" inputMode="numeric" maxLength={1} aria-label="Digit 5" />
      <input className={styles.cell} type="text" inputMode="numeric" maxLength={1} aria-label="Digit 6" />
    </div>
  )
}
