import { Button } from '@alm-design/design-system'
import '@alm-design/design-system/dist/index.css'
import smsIcon from '@alm-design/design-system/src/icons/line-icons/sms.svg?raw'
import arrowDownIcon from '@alm-design/design-system/src/icons/line-icons/arrowDown.svg?raw'
import lightningIcon from '@alm-design/design-system/src/icons/line-icons/lightning.svg?raw'
import discountIcon from '@alm-design/design-system/src/icons/line-icons/discount.svg?raw'
import heroImage from '../assets/6906a410402133cdb77700a369333098815a3221.png'
import styles from './Onboarding.module.css'

type Feature = { icon: string; label: string }

const features: Feature[] = [
  { icon: smsIcon, label: 'Unique rates via WhatsApp, email, and SMS!' },
  { icon: arrowDownIcon, label: 'Price drops before they are gone' },
  { icon: lightningIcon, label: 'Flash sales' },
  { icon: discountIcon, label: 'Offers picked for you' },
]

export default function Onboarding() {
  return (
    <main className={styles.page}>
      <div className={styles.content}>
        <img className={styles.hero} src={heroImage} alt="" />
        <h1 className={styles.title}>Complete your setup. Don&rsquo;t miss out on:</h1>
        <ul className={styles.features}>
          {features.map((f) => (
            <li key={f.label} className={styles.feature}>
              <span className={styles.featureIcon} dangerouslySetInnerHTML={{ __html: f.icon }} />
              <span className={styles.featureLabel}>{f.label}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className={styles.footer}>
        <Button variant="primary" size="default" label="Agree" />
        <Button variant="secondary" size="default" label="Maybe later" />
        <p className={styles.legal}>
          By clicking Agree, I consent to receiving communications and acknowledge the{' '}
          <a className={styles.link} href="#privacy">privacy policy</a>, and{' '}
          <a className={styles.link} href="#terms">terms and conditions</a> You can opt-out anytime.
        </p>
      </div>
    </main>
  )
}
