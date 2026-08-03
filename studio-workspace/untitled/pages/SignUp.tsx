import '@alm-design/design-system/dist/index.css'
import styles from './SignUp.module.css'
import { SheetHandle } from './components/SheetHandle'
import { ChevronLeft, ChevronDown, AppleGlyph, GoogleGlyph } from './components/icons'

export default function SignUp() {
  return (
    <div className={styles.screen}>
      <SheetHandle />

      <div className={styles.sheet}>
        <button className={styles.backBtn} aria-label="Back" type="button">
          <ChevronLeft />
        </button>

        <h1 className={styles.title}>Sign in or create account</h1>

        <div className={styles.form}>
          <div className={styles.phoneField}>
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
            <span className={styles.primaryCtaLabel}>Continue</span>
          </button>

          <button className={styles.registerLink} type="button">
            <span className={styles.registerLinkLabel}>Register as a Business</span>
          </button>
        </div>

        <div className={styles.orRow}>
          <span className={styles.orLine} />
          <span className={styles.orLabel}>OR</span>
          <span className={styles.orLine} />
        </div>

        <div className={styles.socialStack}>
          <button className={styles.outlineBtnAqua} type="button">
            <span className={styles.outlineLabelAqua}>Continue with email</span>
          </button>
          <button className={styles.outlineBtnDark} type="button">
            <span className={styles.outlineIcon}><AppleGlyph /></span>
            <span className={styles.outlineLabelDark}>Continue with Apple</span>
          </button>
          <button className={styles.outlineBtnAqua} type="button">
            <span className={styles.outlineIcon}><GoogleGlyph /></span>
            <span className={styles.outlineLabelAqua}>Continue with Google</span>
          </button>
        </div>
      </div>
    </div>
  )
}
