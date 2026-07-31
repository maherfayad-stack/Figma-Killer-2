import { useState } from 'react'
import StaticScreenshotScreen from './StaticScreenshotScreen'
import EsimSuccessScreen from './EsimSuccessScreen'
import paymentPage from '../../assets/esim-flow/payment page.png'
import { useLanguage } from '../../i18n/LanguageContext'

export default function TopupFlowScreen({ onExit, packageInfo }) {
  const { t } = useLanguage()
  const [step, setStep] = useState('payment') // 'payment' | 'success'

  if (step === 'payment') {
    return (
      <StaticScreenshotScreen
        src={paymentPage}
        alt={t.topup.paymentAlt}
        onClick={() => setStep('success')}
      />
    )
  }

  const detail = packageInfo?.type === 'days'
    ? t.esimSuccess.topupDetailDays(packageInfo.value)
    : t.esimSuccess.topupDetailGb(packageInfo?.value ?? 1)

  return (
    <EsimSuccessScreen
      heading={t.esimSuccess.topupHeading}
      detail={detail}
      onClose={onExit}
      onDone={onExit}
    />
  )
}
