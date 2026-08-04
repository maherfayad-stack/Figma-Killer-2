import { Button, Separator } from '@alm-design/design-system'
import '@alm-design/design-system/dist/index.css'
import '../components/screen.css'
import { StatusBar, BackRow, MobileNumberInput } from '../components/screen'
import styles from './SignUp.module.css'

export default function SignUp() {
  return (
    <div className={styles.screen} dir="ltr">
      <StatusBar />
      <div className={styles.body}>
        <BackRow />
        <h1 className={styles.title}>Sign in or create account</h1>
        <MobileNumberInput />
        <Button variant="secondary" size="default" label="Continue" />
        <a className={styles.registerLink}>Register as a Business</a>
        <div className={styles.orRow}>
          <Separator variant="or" />
        </div>
        <div className={styles.socialButtons}>
          <Button variant="secondary" size="default" label="Continue with email" />
          <button type="button" className={`${styles.socialBtn} ${styles.appleBtn}`}>
            <span className={styles.appleGlyph}></span>
            <span>Continue with Apple</span>
          </button>
          <button type="button" className={styles.socialBtn}>
            <span className={styles.googleGlyph}>G</span>
            <span>Continue with Google</span>
          </button>
        </div>
      </div>
    </div>
  )
}
