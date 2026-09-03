import phoneImage from '../src/assets/EN-2.png'
import appLogoColourSvg from '@alm-design/design-system/src/icons/logo/Type=AppLogo, Variant=Colour, LA=EN.svg?raw'
import appLogoDarkSvg from '@alm-design/design-system/src/icons/logo/Type=AppLogo, Variant=White, LA=NA.svg?raw'
import whatsappSvg from '@alm-design/design-system/src/icons/logotypes/social/whatsapp.svg?raw'
import styles from './OnboardingHero.module.css'
import { useLanguage } from '../i18n/LanguageContext'

/**
 * The onboarding hero: an iPhone lock screen with a push notification laid over
 * it. Only the phone is an image — the notification is real markup, so its text
 * translates and its surface follows the colour scheme. Baking the whole thing
 * into one PNG (which is how it arrives from Figma) gives you a white card and
 * English copy no matter what the app is set to.
 */
export default function OnboardingHero() {
  const { t } = useLanguage()
  return (
    <div className={styles.hero}>
      <img className={styles.phone} src={phoneImage} alt="" />

      <div className={styles.notification}>
        <span className={styles.appIcon}>
          <span className={styles.appLogoLight} dangerouslySetInnerHTML={{ __html: appLogoColourSvg }} />
          <span className={styles.appLogoDark} dangerouslySetInnerHTML={{ __html: appLogoDarkSvg }} />
          <span className={styles.whatsappBadge} dangerouslySetInnerHTML={{ __html: whatsappSvg }} />
        </span>
        <div className={styles.body}>
          <div className={styles.meta}>
            <span className={styles.appName}>{t.onboardingHero.almosafer}</span>
            <span className={styles.time}>{t.onboardingHero._941Am}</span>
          </div>
          <p className={styles.message}>{t.onboardingHero.goodNewsAFewHotels}</p>
        </div>
      </div>
    </div>
  )
}
