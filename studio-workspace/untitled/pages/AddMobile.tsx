import '@alm-design/design-system/dist/index.css'
import styles from './AddMobile.module.css'
import { SheetHandle } from './components/SheetHandle'
import { ChevronLeft, ChevronDown, IconAirplane, IconCalendar, IconDiscount, IconLightning } from './components/icons'

export default function AddMobile() {
  return (
    <div className={styles.screen}>
      <SheetHandle />
      <div className={styles.sheet}>
        <button className={styles.backBtn} aria-label="Back" type="button">
          <ChevronLeft />
        </button>

        <div className={styles.hero} aria-hidden="true">
          <div className={styles.heroInner}>
            <div className={styles.heroPhoneA} />
            <div className={styles.heroPhoneB} />
          </div>
        </div>

        <h1 className={styles.title}>Add your mobile number</h1>
        <p className={styles.subtitle}>Sign in faster next time, and get Notified the moment something changes</p>

        <ul className={styles.bullets}>
          <li className={styles.bullet}>
            <span className={styles.bulletIcon}><IconAirplane /></span>
            <span className={styles.bulletText}>Live flight updates</span>
          </li>
          <li className={styles.bullet}>
            <span className={styles.bulletIcon}><IconCalendar /></span>
            <span className={styles.bulletText}>Boarding pass & activity reminders</span>
          </li>
          <li className={styles.bullet}>
            <span className={styles.bulletIcon}><IconDiscount /></span>
            <span className={styles.bulletText}>Flash sales</span>
          </li>
          <li className={styles.bullet}>
            <span className={styles.bulletIcon}><IconLightning /></span>
            <span className={styles.bulletText}>One-tap sign-in next time</span>
          </li>
        </ul>

        <div className={styles.field}>
          <button className={styles.codeSlot} type="button">
            <span className={styles.codeSlotLabel}>Code</span>
            <span className={styles.codeSlotValue}>+966</span>
            <span className={styles.codeSlotChevron}><ChevronDown /></span>
          </button>
          <div className={styles.numberSlot}>
            <input
              className={styles.numberInput}
              type="tel"
              inputMode="tel"
              placeholder="Mobile number *"
              aria-label="Mobile number"
            />
          </div>
        </div>

        <button className={styles.primaryCta} type="button">
          <span className={styles.primaryCtaLabel}>Verify Number</span>
        </button>
        <p className={styles.legal}>Updates by SMS or WhatsApp. No marketing spam.</p>
      </div>
    </div>
  )
}
