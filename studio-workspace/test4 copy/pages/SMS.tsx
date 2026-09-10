import type { ClipboardEvent, FormEvent, KeyboardEvent } from 'react'
import smsSvg from '@alm-design/design-system/src/icons/line-icons/sms.svg?raw'
import SheetHeader from '../components/SheetHeader'
import styles from './SMS.module.css'
import { useLanguage } from '../i18n/LanguageContext'

/** Where the flow goes once all six digits are in: marketing consent. */
const CONSENT_ROUTE = '/onboarding'

/**
 * The six boxes are UNCONTROLLED, and every rule below is enforced on the DOM
 * node rather than through React state.
 *
 * Two reasons. Studio's canvas PARSES this file and never executes it — at the
 * `static` trust tier none of this runs there at all — so a `value={code[i]}`
 * box would be frozen empty and untypable on the canvas. And in the real app
 * the browser already owns the box's value; reading it back is both simpler and
 * more honest than mirroring it into state that only this row consumes.
 *
 * ONE delegated handler per concern on the row, not six per input: the boxes
 * are siblings, so "the next box" is just `nextElementSibling`.
 */
const boxes = (row: Element) => Array.from(row.children).filter((child): child is HTMLInputElement => child instanceof HTMLInputElement)

/** All six digits are in — hand off to the consent screen. */
function completeCode(box: HTMLInputElement) {
  box.blur()
  window.location.assign(CONSENT_ROUTE)
}

/**
 * Reject anything that is not a digit BEFORE it lands in the box.
 *
 * `inputMode="numeric"` only asks the soft keyboard for digits — a hint, not a
 * constraint, and a hardware keyboard ignores it entirely. Cancelling the
 * insertion is what actually keeps a letter out, on every keyboard. Paste is
 * handled separately, in `spreadCode`.
 */
function rejectNonDigits(event: FormEvent<HTMLDivElement>) {
  if (!(event.target instanceof HTMLInputElement)) return
  if (!(event.nativeEvent instanceof InputEvent)) return
  // No data means a deletion or a composition step — never a character to vet.
  const { data } = event.nativeEvent
  if (data && /\D/.test(data)) event.preventDefault()
}

/** Move to the next box as a digit lands; complete on the last one. */
function advanceCode(event: FormEvent<HTMLDivElement>) {
  const box = event.target
  if (!(box instanceof HTMLInputElement)) return
  // Belt and braces behind maxLength + rejectNonDigits: autofill and the
  // password managers that drive it bypass `beforeinput` entirely.
  box.value = box.value.replace(/\D/g, '').slice(-1)
  if (!box.value) return
  const next = box.nextElementSibling
  if (next instanceof HTMLInputElement) next.focus()
  else completeCode(box)
}

/** Backspace in an empty box steps back to the previous one. */
function retreatCode(event: KeyboardEvent<HTMLDivElement>) {
  const box = event.target
  if (event.key !== 'Backspace') return
  if (!(box instanceof HTMLInputElement) || box.value) return
  const previous = box.previousElementSibling
  if (previous instanceof HTMLInputElement) previous.focus()
}

/**
 * A pasted code fills the row, one digit per box.
 *
 * Without this the whole "123456" lands in one box, which `maxLength` then
 * truncates to a single digit — the code arrives as garbage. Pasting an SMS
 * code is how most people enter one, so it gets handled rather than clamped.
 */
function spreadCode(event: ClipboardEvent<HTMLDivElement>) {
  const box = event.target
  if (!(box instanceof HTMLInputElement)) return
  const digits = event.clipboardData.getData('text').replace(/\D/g, '')
  if (!digits) return
  event.preventDefault()

  const row = boxes(event.currentTarget)
  const start = row.indexOf(box)
  const filled = row.slice(start, start + digits.length)
  filled.forEach((target, offset) => {
    target.value = digits[offset]
  })

  const last = filled[filled.length - 1]
  const next = last.nextElementSibling
  if (next instanceof HTMLInputElement) next.focus()
  else completeCode(last)
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

          <div
            className={styles.codeInputs}
            onBeforeInput={rejectNonDigits}
            onInput={advanceCode}
            onKeyDown={retreatCode}
            onPaste={spreadCode}
          >
            <input className={styles.codeInput} type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code" maxLength={1} aria-label={t.sMS.digit1} />
            <input className={styles.codeInput} type="text" inputMode="numeric" pattern="[0-9]*" maxLength={1} aria-label={t.sMS.digit2} />
            <input className={styles.codeInput} type="text" inputMode="numeric" pattern="[0-9]*" maxLength={1} aria-label={t.sMS.digit3} />
            <input className={styles.codeInput} type="text" inputMode="numeric" pattern="[0-9]*" maxLength={1} aria-label={t.sMS.digit4} />
            <input className={styles.codeInput} type="text" inputMode="numeric" pattern="[0-9]*" maxLength={1} aria-label={t.sMS.digit5} />
            <input className={styles.codeInput} type="text" inputMode="numeric" pattern="[0-9]*" maxLength={1} aria-label={t.sMS.digit6} />
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
