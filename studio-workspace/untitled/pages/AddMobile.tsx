import { Button } from '@alm-design/design-system'
import '@alm-design/design-system/dist/index.css'
import '../components/screen.css'
import planeSvg from '@alm-design/design-system/src/icons/line-icons/planeLine.svg?raw'
import calendarSvg from '@alm-design/design-system/src/icons/line-icons/calendar.svg?raw'
import discountSvg from '@alm-design/design-system/src/icons/line-icons/discount.svg?raw'
import lightningSvg from '@alm-design/design-system/src/icons/line-icons/lightning.svg?raw'
import { StatusBar, BackRow, MobileNumberInput, PerkRow } from '../components/screen'
import styles from './AddMobile.module.css'

export default function AddMobile() {
  return (
    <div className={styles.screen} dir="ltr">
      <StatusBar />
      <div className={styles.body}>
        <BackRow />
        <div className={styles.hero} aria-label="hero image gap" />
        <h2 className={styles.title}>Add your mobile number</h2>
        <p className={styles.copy}>
          Sign in faster next time, and get Notifed the moment something changes
        </p>
        <div className={styles.perkList}>
          <PerkRow svg={planeSvg} label="Live flight updates" />
          <PerkRow svg={calendarSvg} label="Boarding pass & activity reminders" />
          <PerkRow svg={discountSvg} label="Flash sales" />
          <PerkRow svg={lightningSvg} label="One-tap sign-in next time" />
        </div>
        <div className={styles.bottom}>
          <MobileNumberInput />
          <Button variant="primary" size="default" label="Verify Number" />
          <p className={styles.finePrint}>Updates by SMS or WhatsApp. No marketing spam.</p>
        </div>
      </div>
    </div>
  )
}
