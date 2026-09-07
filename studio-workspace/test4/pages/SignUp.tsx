import { useState } from 'react'
import { Button, Separator, TextInput } from '@alm-design/design-system'
// The Apple mark paints from `currentColor` so it follows the button label.
import appleLogoSvg from '../assets/1540a1e9-9c03-43d2-8d50-477cd174d411.svg?raw'
import googleLogoSvg from '../assets/77fcc482-0448-425c-9a08-c4e26d4f2bf6.svg?raw'
import SheetHeader from '../components/SheetHeader'
import styles from './SignUp.module.css'
import { useLanguage } from '../i18n/LanguageContext'

export default function SignUp() {
  const { t } = useLanguage()
  // Real state. These were `value="+966" onChange={() => {}}` — a CONTROLLED
  // React input whose handler throws every keystroke away, so the field could
  // never change no matter where it was rendered. That is why nothing could be
  // typed into these fields in the canvas, in live mode, or in the exported
  // prototype.
  const [code, setCode] = useState('+966')
  const [mobileNumber, setMobileNumber] = useState('')
  return (
    <main className={styles.page}>
      <SheetHeader />

      <div className={styles.banner}>
        <h1 className={styles.title}>{t.signUp.signInOrCreateAccount}</h1>

        <div className={styles.form}>
          <div className={styles.fields}>
            <div className={styles.phoneRow}>
              <div className={styles.codeField}>
                <TextInput label={t.signUp.code} value={code} onChange={(e) => setCode(e.target.value)} dropdown />
              </div>
              <div className={styles.numberField}>
                <TextInput label={t.signUp.mobileNumber} value={mobileNumber} onChange={(e) => setMobileNumber(e.target.value)} required disabled={false} errorText="" skeleton={false} password={false} multiline={false} />
              </div>
            </div>

            <div className={styles.continueSlot}>
              <Button variant="primary" size="default" label={t.signUp.continue} className={`${styles.continueButton} SignUp_continueButton__9443c`} />
            </div>

            <p className={styles.businessLink}>{t.signUp.registerAsABusiness}</p>
          </div>

          <div className={styles.divider}>
            <Separator variant="or" />
          </div>

          <div className={styles.altSignIn}>
            <div className={styles.outlineSlot}>
              <Button
                variant="primary-inverted"
                size="default"
                label={t.signUp.continueWithEmail}
                className={styles.outlineButton}
              />
            </div>
            <div className={styles.appleSlot}>
              <Button
                variant="primary-inverted"
                size="default"
                label={t.signUp.continueWithApple}
                className={styles.appleButton}
                leadingIcon={<span dangerouslySetInnerHTML={{ __html: appleLogoSvg }} />}
              />
            </div>
            <div className={styles.outlineSlot}>
              <Button
                variant="primary-inverted"
                size="default"
                label={t.signUp.continueWithGoogle}
                className={styles.outlineButton}
                leadingIcon={<span dangerouslySetInnerHTML={{ __html: googleLogoSvg }} />}
              />
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}
