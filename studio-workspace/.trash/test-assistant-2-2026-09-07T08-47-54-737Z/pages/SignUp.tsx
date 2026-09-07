import { Button, ChevronLeftIcon, ChevronDownIcon } from '@alm-design/design-system'
import '@alm-design/design-system/dist/index.css'
import appleLogo from '../assets/71155a32d7ec8d583368f5e29cf36ef7f6056e3d.svg'
import googleLogo from '../assets/fcab4c5427248094cd469ea72190ba22bbf12da8.svg'
import styles from './SignUp.module.css'

export default function SignUp() {
  return (
    <main className={styles.page}>
      <button type="button" className={styles.back} aria-label="Back">
        <ChevronLeftIcon className={styles.backIcon} />
      </button>
      <div className={styles.body}>
        <h1 className={styles.title}>Sign in or create account</h1>
        <div className={styles.phoneRow}>
          <div className={styles.codeField}>
            <span className={styles.codeLabel}>Code</span>
            <span className={styles.codeValue}>+966</span>
            <ChevronDownIcon className={styles.codeChevron} />
          </div>
          <div className={styles.numberField}>
            <span className={styles.numberPlaceholder}>
              Mobile number <span className={styles.required}>*</span>
            </span>
          </div>
        </div>
        <Button variant="primary" size="default" label="Continue" />
        <a className={styles.businessLink} href="#business">Register as a Business</a>

        <div className={styles.separator}>
          <span className={styles.separatorLine} aria-hidden="true" />
          <span className={styles.separatorLabel}>OR</span>
          <span className={styles.separatorLine} aria-hidden="true" />
        </div>

        <div className={styles.socials}>
          <button type="button" className={`${styles.social} ${styles.socialGhost}`}>
            <span className={styles.socialLabelAqua}>Continue with email</span>
          </button>
          <button type="button" className={`${styles.social} ${styles.socialApple}`}>
            <img src={appleLogo} alt="" className={styles.socialIcon} />
            <span className={styles.socialLabelDark}>Continue with Apple</span>
          </button>
          <button type="button" className={`${styles.social} ${styles.socialGoogle}`}>
            <img src={googleLogo} alt="" className={styles.socialIcon} />
            <span className={styles.socialLabelAqua}>Continue with Google</span>
          </button>
        </div>
      </div>
    </main>
  )
}
