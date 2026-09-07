import { BottomSheet, Button, Separator } from '@alm-design/design-system'
import '@alm-design/design-system/dist/index.css'
import chevronDownRaw from '@alm-design/design-system/src/icons/line-icons/chevronDown.svg?raw'
import chevronLeftRaw from '@alm-design/design-system/src/icons/line-icons/chevronLeft.svg?raw'
import appleIcon from '../src/assets/71155a32d7ec8d583368f5e29cf36ef7f6056e3d.svg?raw'
import googleIcon from '../src/assets/fcab4c5427248094cd469ea72190ba22bbf12da8.svg?raw'
import styles from './SignUp.module.css'
import { useLanguage } from '../src/i18n/LanguageContext'

export default function SignUp() {
  const { t } = useLanguage()
  return (
    <main className={styles.page}>
      <BottomSheet open size="fullscreen" platform="ios">
        <div className={styles.wrapper}>
          <div className={styles.body}>
            <div className={styles.top}>
              <div className={styles.header}>
                <button type="button" className={styles.backBtn} aria-label={t.signUp.back}>
                  <span className={styles.iconSm} dangerouslySetInnerHTML={{ __html: chevronLeftRaw }} />
                </button>
                <h1 className={styles.title}>{t.signUp.signInOrCreateAccount}</h1>
              </div>

              <div className={styles.mobileRow}>
                <div className={styles.codeField}>
                  <div className={styles.codeInner}>
                    <span className={styles.codeLabel}>{t.signUp.code}</span>
                    <span className={styles.codeValue}>+966</span>
                  </div>
                  <span className={styles.iconSm} dangerouslySetInnerHTML={{ __html: chevronDownRaw }} />
                </div>
                <div className={styles.numberField}>
                  <span className={styles.numberPlaceholder}>
                    {t.signUp.mobileNumber} <span className={styles.required}>*</span>
                  </span>
                </div>
              </div>

              <Button variant="primary" size="default" label={t.signUp.continue} />

              <p className={styles.registerBusiness}>{t.signUp.registerAsABusiness}</p>
            </div>

            <div className={styles.bottom}>
              <div className={styles.orSeparator}>
                <Separator variant="or" />
              </div>

              <div className={styles.socialGroup}>
                <Button variant="secondary" size="default" label={t.signUp.continueWithEmail} />
                <button type="button" className={`${styles.socialBtn} ${styles.socialBtnApple}`}>
                  <span className={styles.iconSm} dangerouslySetInnerHTML={{ __html: appleIcon }} />
                  <span className={styles.socialLabel}>{t.signUp.continueWithApple}</span>
                </button>
                <button type="button" className={`${styles.socialBtn} ${styles.socialBtnGoogle}`}>
                  <span className={styles.iconSm} dangerouslySetInnerHTML={{ __html: googleIcon }} />
                  <span className={styles.socialLabel}>{t.signUp.continueWithGoogle}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </BottomSheet>
    </main>
  )
}
