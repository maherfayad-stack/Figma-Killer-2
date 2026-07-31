import { useState } from 'react'
import ActivateIntroScreen from './ActivateIntroScreen'
import OnboardingCarouselScreen from './OnboardingCarouselScreen'
import ActivateSettingsScreen from './ActivateSettingsScreen'
import QrCodeScreen from './QrCodeScreen'
import EsimSuccessScreen from './EsimSuccessScreen'
import { useLanguage } from '../../i18n/LanguageContext'

export default function ActivationFlowScreen({ onExit, initialStep = 'intro', introVariant = 'checklist' }) {
  const { t } = useLanguage()
  const [step, setStep] = useState(initialStep) // 'intro' | 'settings' | 'qr' | 'success'

  return (
    <>
      {step === 'intro' && introVariant === 'onboarding' && (
        <OnboardingCarouselScreen onClose={onExit} onInstall={() => setStep('settings')} />
      )}
      {step === 'intro' && introVariant !== 'onboarding' && (
        <ActivateIntroScreen onClose={onExit} onInstall={() => setStep('settings')} />
      )}
      {step === 'settings' && (
        <ActivateSettingsScreen onClose={onExit} onDone={() => setStep('success')} />
      )}
      {step === 'qr' && <QrCodeScreen onClose={onExit} onDone={onExit} />}
      {step === 'success' && (
        <EsimSuccessScreen
          heading={t.esimSuccess.activateHeading}
          detail={t.esimSuccess.activateDetail}
          stepLabel={t.esimSuccess.activateStepLabel}
          onClose={onExit}
          onDone={onExit}
        />
      )}
    </>
  )
}
