import type { FormEvent, KeyboardEvent } from 'react'
import smsSvg from '@alm-design/design-system/src/icons/line-icons/sms.svg?raw'
import SheetHeader from '../components/SheetHeader'
import styles from './SMS.module.css'
import { useLanguage } from '../i18n/LanguageContext'

/**
 * Move to the next box as a digit lands, and back on a delete from an empty
 * one — the behaviour every OTP field has.
 *
 * ONE delegated handler on the row rather than six per-input ones: the boxes
 * are siblings, so "the next box" is just `nextElementSibling`, and a screen in
 * this project stays a static composition (see CLAUDE.md) instead of growing
 * six pieces of state.
 *
 * The boxes are UNCONTROLLED on purpose. Studio's canvas parses this file, it
 * does not execute it, so a `value={code[i]}` box would be frozen empty there
 * and impossible to type into. Uncontrolled, the browser fills them in by
 * itself and this handler is pure polish that runs in the real app.
 */
function advanceCode(event: FormEvent<HTMLDivElement>) {
  const box = event.target
  if (!(box instanceof HTMLInputElement)) return
  box.value = box.value.replace(/\D/g, '').slice(-1)
  const next = box.nextElementSibling
  if (box.value && next instanceof HTMLInputElement) next.focus()
}

function retreatCode(event: KeyboardEvent<HTMLDivElement>) {
  const box = event.target
  if (event.key !== 'Backspace') return
  if (!(box instanceof HTMLInputElement) || box.value) return
  const previous = box.previousElementSibling
  if (previous instanceof HTMLInputElement) previous.focus()
}

export default function SMS() {
  const { t } = useLanguage()
  return (
    <main className={styles.page}>
      <div className={styles.header}>
        <SheetHeader />
      </div>

      <div className={styles.banner}>
        <h1 className={styles.title}>{t.sMS.enterVerificationCode}</h1>

        <div className={styles.form}>
          <div className={styles.channel}>
            <p className={styles.channelLabel}>{t.sMS.enterThe6DigitCode}</p>
            <p className={styles.channelValue}>
              <span className={styles.icon} dangerouslySetInnerHTML={{ __html: smsSvg }} />
              <span>
                <span className={styles.strong}>{t.sMS.sms}</span>
                <span className={styles.at}>{t.sMS.at}</span>
                <span className={styles.strong}>+966 55 333 4444</span>
              </span>
            </p>
          </div>

          <div className={styles.codeInputs} onInput={advanceCode} onKeyDown={retreatCode}>
            <input className={styles.codeInput} type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={1} aria-label={t.sMS.digit1} />
            <input className={styles.codeInput} type="text" inputMode="numeric" maxLength={1} aria-label={t.sMS.digit2} />
            <input className={styles.codeInput} type="text" inputMode="numeric" maxLength={1} aria-label={t.sMS.digit3} />
            <input className={styles.codeInput} type="text" inputMode="numeric" maxLength={1} aria-label={t.sMS.digit4} />
            <input className={styles.codeInput} type="text" inputMode="numeric" maxLength={1} aria-label={t.sMS.digit5} />
            <input className={styles.codeInput} type="text" inputMode="numeric" maxLength={1} aria-label={t.sMS.digit6} />
          </div>

          <p className={styles.resend}>
            <span className={styles.resendRun}>{t.sMS.resendIn}</span>
            <span className={styles.strongCaption}>{t.sMS._29Seconds}</span>
          </p>
        </div>
      </div>
    </main>
  )
}
