import { Button } from '@alm-design/design-system'
import '@alm-design/design-system/dist/index.css'
import '../components/screen.css'
import smsSvg from '@alm-design/design-system/src/icons/line-icons/sms.svg?raw'
import lightningSvg from '@alm-design/design-system/src/icons/line-icons/lightning.svg?raw'
import discountSvg from '@alm-design/design-system/src/icons/line-icons/discount.svg?raw'
import percentSvg from '@alm-design/design-system/src/icons/line-icons/percentSimple.svg?raw'
import { StatusBar, PerkRow } from '../components/screen'
import styles from './Onboarding.module.css'

export default function Onboarding() {
  return (
    <div className={styles.screen} dir="ltr">
      <StatusBar />
      <div className={styles.body}>
        <div className={styles.hero} aria-label="onboarding hero gap" />
        <h2 className={styles.title}>
          Complete your setup.<br />Don&apos;t miss out on:
        </h2>
        <div className={styles.perkList}>
          <PerkRow svg={smsSvg} label="Unique rates via WhatsApp, email, and SMS!" />
          <PerkRow svg={percentSvg} label="Price drops before they are gone" />
          <PerkRow svg={lightningSvg} label="Flash sales" />
          <PerkRow svg={discountSvg} label="Offers picked for you" />
        </div>
        <div className={styles.cta}>
          <Button variant="primary" size="default" label="Agree" />
          <a className={styles.link}>Maybe later</a>
          <p className={styles.legal}>
            By clicking Agree, I consent to receiving communications and acknowledge the{' '}
            <a>privacy policy</a>, and <a>Terms and conditions</a> You can opt-out anytime.
          </p>
        </div>
      </div>
    </div>
  )
}
