import '@alm-design/design-system/dist/index.css'
import styles from './Onboarding.module.css'
import { IconSms, IconChartDown, IconLightning, IconDiscount } from './components/icons'

export default function Onboarding() {
  return (
    <div className={styles.screen}>
      <div className={styles.statusBar}>
        <span className={styles.time}>9:41</span>
        <span className={styles.statusIcons} aria-hidden="true">
          <svg width="18" height="12" viewBox="0 0 18 12"><g fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="6" width="3" height="6" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></g></svg>
          <svg width="16" height="12" viewBox="0 0 16 12"><path fill="currentColor" d="M8 2.5c2.05 0 3.98.75 5.48 2.05l1.35-1.35A9.5 9.5 0 0 0 8 0a9.5 9.5 0 0 0-6.83 3.2L2.52 4.55A7.53 7.53 0 0 1 8 2.5zm0 3.75c1.1 0 2.13.4 2.92 1.08l1.35-1.35A6.5 6.5 0 0 0 8 4.25a6.5 6.5 0 0 0-4.27 1.58L5.08 7.18A4.5 4.5 0 0 1 8 6.25zm0 3.75a2.25 2.25 0 0 0-1.59.66L8 12l1.59-1.34A2.25 2.25 0 0 0 8 10z"/></svg>
          <svg width="26" height="12" viewBox="0 0 26 12"><rect x="0.5" y="0.5" width="22" height="11" rx="3" fill="none" stroke="currentColor"/><rect x="23.5" y="4" width="1.5" height="4" rx="0.5" fill="currentColor"/><rect x="2" y="2" width="19" height="8" rx="1.5" fill="currentColor"/></svg>
        </span>
      </div>

      <div className={styles.body}>
        <div className={styles.hero} aria-hidden="true">
          <div className={styles.phoneFrame}>
            <div className={styles.phoneIsland} />
            <div className={styles.phoneDate}><span className={styles.phoneDateText}>Sunday, March 10</span></div>
            <div className={styles.phoneTime}><span className={styles.phoneTimeText}>9:41</span></div>
          </div>
          <div className={styles.notif}>
            <div className={styles.notifIcon}>
              <div className={styles.notifIconBase} />
              <div className={styles.notifIconChat} />
            </div>
            <div className={styles.notifContent}>
              <div className={styles.notifHead}>
                <span className={styles.notifApp}>Almosafer</span>
                <span className={styles.notifTime}>9:41 AM</span>
              </div>
              <div className={styles.notifText}>
                <span className={styles.notifTextInner}>Good news! A few hotels you were interested in just had a 30% price drop</span>
              </div>
            </div>
          </div>
        </div>

        <h1 className={styles.title}>
          <span className={styles.titleLine}>Complete your setup.</span>
          <span className={styles.titleLine}>Don't miss out on:</span>
        </h1>

        <ul className={styles.bullets}>
          <li className={styles.bullet}>
            <span className={styles.bulletIcon}><IconSms /></span>
            <span className={styles.bulletText}>Unique rates via WhatsApp, email, and SMS!</span>
          </li>
          <li className={styles.bullet}>
            <span className={styles.bulletIcon}><IconChartDown /></span>
            <span className={styles.bulletText}>Price drops before they are gone</span>
          </li>
          <li className={styles.bullet}>
            <span className={styles.bulletIcon}><IconLightning /></span>
            <span className={styles.bulletText}>Flash sales</span>
          </li>
          <li className={styles.bullet}>
            <span className={styles.bulletIcon}><IconDiscount /></span>
            <span className={styles.bulletText}>Offers picked for you</span>
          </li>
        </ul>

        <div className={styles.actions}>
          <button className={styles.primaryCta} type="button">
            <span className={styles.primaryCtaLabel}>Agree</span>
          </button>
          <button className={styles.maybeLater} type="button">
            <span className={styles.maybeLaterLabel}>Maybe later</span>
          </button>
        </div>

        <p className={styles.legal}>
          <span className={styles.legalText}>By clicking Agree, I consent to receiving communications and acknowledge the </span>
          <a className={styles.legalLink} href="#privacy"><span className={styles.legalLinkText}>privacy policy</span></a>
          <span className={styles.legalText}>, and </span>
          <a className={styles.legalLink} href="#terms"><span className={styles.legalLinkText}>terms and conditions</span></a>
          <span className={styles.legalText}> You can opt-out anytime.</span>
        </p>
      </div>
    </div>
  )
}
