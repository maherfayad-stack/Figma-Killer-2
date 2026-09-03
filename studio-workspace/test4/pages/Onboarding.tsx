import styles from './Onboarding.module.css'
import { Button } from '@alm-design/design-system'
import discountSvg from '@alm-design/design-system/src/icons/line-icons/discount.svg?raw'
import lightningSvg from '@alm-design/design-system/src/icons/line-icons/lightning.svg?raw'
import smsSvg from '@alm-design/design-system/src/icons/line-icons/sms.svg?raw'
import chartLineDownSvg from '../assets/cf9f4f5a-713a-4a3b-aceb-dacabb79e562.svg?raw'
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
            <h1 className={styles.title}>{t.onboarding.completeYourSetupDonT}</h1>

            <ul className={styles.features}>
              <li className={styles.feature}>
                <span className={styles.icon} dangerouslySetInnerHTML={{ __html: smsSvg }} />
                <span className={styles.featureText}>{t.onboarding.uniqueRatesViaWhatsappEmail}</span>
              </li>
              <li className={styles.feature}>
                <span className={styles.icon} dangerouslySetInnerHTML={{ __html: chartLineDownSvg }} />
                <span className={styles.featureText} style={{ width: "200px" }}>{t.onboarding.priceDropsBeforeTheyAre}</span>
              </li>
              <li className={styles.feature}>
                <span className={styles.icon} dangerouslySetInnerHTML={{ __html: lightningSvg }} />
                <span className={styles.featureText}>{t.onboarding.flashSales}</span>
              </li>
              <li className={styles.feature}>
                <span className={styles.icon} dangerouslySetInnerHTML={{ __html: discountSvg }} />
                <span className={styles.featureText}>{t.onboarding.offersPickedForYou}</span>
              </li>
            </ul>
          </div>
        </div>

        <div className={styles.footer}>
          <div className={styles.cta} style={{ width: "360px" }}>
            <Button variant="primary" size="default" label={t.onboarding.agree} className={styles.ctaButton} style={{ width: "364px", alignSelf: "stretch" }} />
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
