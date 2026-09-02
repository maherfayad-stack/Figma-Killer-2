import { Button } from '@alm-design/design-system'
import '@alm-design/design-system/dist/index.css'
import smsIcon from '@alm-design/design-system/src/icons/line-icons/chat.svg?raw'
import lightningIcon from '@alm-design/design-system/src/icons/line-icons/lightning.svg?raw'
import discountIcon from '@alm-design/design-system/src/icons/line-icons/discount.svg?raw'
import chartLineDownIcon from '../src/assets/930edc57bedfd1b18e26c723c54de9bf81d32dc9.svg?raw'
import heroImage from '../src/assets/6906a410402133cdb77700a369333098815a3221.png'
import styles from './Onboarding.module.css'
import { useLanguage } from '../src/i18n/LanguageContext'

export default function Onboarding() {
  const { t } = useLanguage()
  return (
    <main className={styles.page}>
      <div className={styles.content}>
        <div className={styles.hero}>
          <img src={heroImage} alt="" className={styles.heroImage} />
          <div className={styles.textBlock}>
            <h1 className={styles.title}>{t.onboarding.completeYourSetupDonRsquo}</h1>
            <ul className={styles.features}>
              <li className={styles.feature}>
                <span className={styles.featureIcon} dangerouslySetInnerHTML={{ __html: smsIcon }} />
                <p className={styles.featureText}>{t.onboarding.uniqueRatesViaWhatsappEmail}</p>
              </li>
              <li className={styles.feature}>
                <span className={styles.featureIcon} dangerouslySetInnerHTML={{ __html: chartLineDownIcon }} />
                <p className={styles.featureText}>{t.onboarding.priceDropsBeforeTheyAre}</p>
              </li>
              <li className={styles.feature}>
                <span className={styles.featureIcon} dangerouslySetInnerHTML={{ __html: lightningIcon }} />
                <p className={styles.featureText}>{t.onboarding.flashSales}</p>
              </li>
              <li className={styles.feature}>
                <span className={styles.featureIcon} dangerouslySetInnerHTML={{ __html: discountIcon }} />
                <p className={styles.featureText}>{t.onboarding.offersPickedForYou}</p>
              </li>
            </ul>
          </div>
        </div>
        <div className={styles.footer}>
          <Button variant="primary" size="default" label={t.onboarding.agree} />
          <Button variant="secondary" size="default" label={t.onboarding.maybeLater} />
          <p className={styles.disclaimer}>
            <span className={styles.disclaimerText}>{t.onboarding.byClickingAgreeIConsent} </span>
            <a href="#" className={styles.disclaimerLink}>{t.onboarding.privacyPolicy}</a>
            <span className={styles.disclaimerText}>{t.onboarding.and} </span>
            <a href="#" className={styles.disclaimerLink}>{t.onboarding.termsAndConditions}</a>
            <span className={styles.disclaimerText}> {t.onboarding.youCanOptOutAnytime}</span>
          </p>
        </div>
        <div className={styles.homeIndicator} />
      </div>
    </main>
  )
}
