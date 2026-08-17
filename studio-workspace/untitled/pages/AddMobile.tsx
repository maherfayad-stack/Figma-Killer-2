import { Button, TextInput, ChevronDownIcon } from '@alm-design/design-system'
import airplaneSvg from '@alm-design/design-system/src/icons/line-icons/airplaneTilt.svg?raw'
import calendarSvg from '@alm-design/design-system/src/icons/line-icons/calendar.svg?raw'
import discountSvg from '@alm-design/design-system/src/icons/line-icons/discount.svg?raw'
import lightningSvg from '@alm-design/design-system/src/icons/line-icons/lightning.svg?raw'
import { Screen } from '../components/Screen'
import styles from './AddMobile.module.css'

const features = [
  { svg: airplaneSvg, label: 'Live flight updates' },
  { svg: calendarSvg, label: 'Boarding pass & activity reminders' },
  { svg: discountSvg, label: 'Flash sales' },
  { svg: lightningSvg, label: 'One-tap sign-in next time' },
]

export default function AddMobile() {
  return (
    <Screen>
      <div className={styles.hero} aria-hidden />

      <div className={styles.heading}>
        <h1 className={styles.title}>Add your mobile number</h1>
        <p className={styles.subtitle}>
          Sign in faster next time, and get Notified the moment something changes
        </p>
      </div>

      <ul className={styles.features}>
        {features.map((f) => (
          <li key={f.label} className={styles.feature}>
            <span className={styles.featureIcon} dangerouslySetInnerHTML={{ __html: f.svg }} />
            <span>{f.label}</span>
          </li>
        ))}
      </ul>

      <div className={styles.formSection}>
        <div className={styles.phoneRow}>
          <button type="button" className={styles.codeField}>
            <span className={styles.codeLabel}>Code</span>
            <span className={styles.codeValue}>+966</span>
            <ChevronDownIcon className={styles.chev} />
          </button>
          <div className={styles.numberField}>
            <TextInput label="Mobile number" required value="" onChange={() => {}} />
          </div>
        </div>

        <div className={styles.verifyBtn}>
          <Button variant="primary" size="medium" label="Verify Number" />
        </div>

        <p className={styles.footnote}>
          Updates by SMS or WhatsApp. No marketing spam.
        </p>
      </div>
    </Screen>
  )
}
