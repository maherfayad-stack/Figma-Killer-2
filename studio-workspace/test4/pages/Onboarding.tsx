import styles from './Onboarding.module.css'
import { Button } from '../design-system'
import IOSStatusBar from '../components/IOSStatusBar'
import OnboardingHero from '../components/OnboardingHero'
import { useLanguage } from '../i18n/LanguageContext'

export default function Onboarding() {
  const { t } = useLanguage()
  return (
    <main className={styles.page}>
      <IOSStatusBar />

      <div className={styles.body}>
        <div className={styles.top}>
          <OnboardingHero />

          <div className={styles.copy}>

            <ul className={styles.features}>
            </ul>
          </div>
        </div>

        <div className={styles.footer}>
          <div className={styles.cta} style={{ width: "360px" }}>
            <Button variant="primary" size="medium" label={t.onboarding.agree} className={styles.ctaButton} />
          </div>
          <div className={styles.cta}>
            <Button variant="primary-inverted" size="default" label={t.onboarding.maybeLater} className={styles.ctaButton} />
          </div>
          <p className={styles.legal}>
            <span className={styles.legalRun}>{t.onboarding.byClickingAgreeIConsent}</span>
            <span className={styles.link}>{t.onboarding.privacyPolicy}</span>
            <span className={styles.legalRun}>{t.onboarding.and}</span>
            <span className={styles.linkSpaced}>{t.onboarding.termsAndConditions}</span>
            <span>{t.onboarding.youCanOptOutAnytime}</span>
          </p>
        </div>
      </div>
    </main>
  )
}
