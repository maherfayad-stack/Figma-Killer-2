import { Button } from '@alm-design/design-system'
import smsSvg from '@alm-design/design-system/src/icons/line-icons/sms.svg?raw'
import chartSvg from '@alm-design/design-system/src/icons/line-icons/discount.svg?raw'
import lightningSvg from '@alm-design/design-system/src/icons/line-icons/lightning.svg?raw'
import discountSvg from '@alm-design/design-system/src/icons/line-icons/percentSimple.svg?raw'
import '@alm-design/design-system/dist/index.css'
import '../styles/fonts.css'
import styles from './Onboarding.module.css'

const features = [
  { svg: smsSvg, label: 'Unique rates via WhatsApp, email, and SMS!' },
  { svg: chartSvg, label: 'Price drops before they are gone' },
  { svg: lightningSvg, label: 'Flash sales' },
  { svg: discountSvg, label: 'Offers picked for you' },
]

export default function Onboarding() {
  return (
    <div className={styles.screen}>
      <div className={styles.statusBar}>
        <span className={styles.time}>9:41</span>
        <span className={styles.dots}>••••  ▲  </span>
        <span className={styles.battery} />
      </div>

      <div className={styles.hero} aria-hidden>
        <div className={styles.heroInner}>
          <div className={styles.heroDate}>Sunday, March 10</div>
          <div className={styles.heroTime}>9:41</div>
          <div className={styles.notification}>
            <div className={styles.notifIcon} />
            <div className={styles.notifBody}>
              <div className={styles.notifHead}>
                <span className={styles.notifTitle}>Almosafer</span>
                <span className={styles.notifTime}>9:41 AM</span>
              </div>
              <p className={styles.notifText}>
                Good news! A few hotels you were interested in just had a 30% price drop
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.body}>
        <h1 className={styles.title}>
          Complete your setup.<br />
          Don't miss out on:
        </h1>

        <ul className={styles.features}>
          {features.map((f) => (
            <li key={f.label} className={styles.feature}>
              <span className={styles.featureIcon} dangerouslySetInnerHTML={{ __html: f.svg }} />
              <span>{f.label}</span>
            </li>
          ))}
        </ul>

        <div className={styles.actions}>
          <div className={styles.primaryBtn}>
            <Button variant="primary" size="medium" label="Agree" />
          </div>
          <button type="button" className={styles.textBtn}>Maybe later</button>
          <p className={styles.legal}>
            By clicking Agree, I consent to receiving communications and acknowledge the{' '}
            <a href="#">privacy policy</a>, and <a href="#">terms and conditions</a> You can opt-out anytime.
          </p>
        </div>
      </div>
    </div>
  )
}
