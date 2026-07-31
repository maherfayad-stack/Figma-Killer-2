import { useState } from 'react'
import { Button } from '@alm-design/design-system'
import SheetShell from '../../components/SheetShell'
import ProgressSignal from '../../components/ProgressSignal'
import onboarding1 from '../../assets/esim-flow/figma/onboarding-1.png'
import onboarding2 from '../../assets/esim-flow/figma/onboarding-2.png'
import onboarding3 from '../../assets/esim-flow/figma/onboarding-3.png'
import { useLanguage } from '../../i18n/LanguageContext'
import './esim-shared.css'
import './OnboardingCarouselScreen.css'

const SLIDE_IMAGES = [onboarding1, onboarding2, onboarding3]

export default function OnboardingCarouselScreen({ onClose, onInstall }) {
  const { t } = useLanguage()
  const [index, setIndex] = useState(0)
  const slides = t.onboardingIntro.slides
  const total = slides.length
  const isLast = index === total - 1
  const slide = slides[index]

  const handleNext = () => {
    if (isLast) onInstall()
    else setIndex((i) => i + 1)
  }

  return (
    <SheetShell title="" onClose={onClose} className="onboarding-carousel">
      <div className="esim-sheet__scroll">
        <div className="esim-sheet__body">
          <div className="esim-intro__progress">
            <ProgressSignal step={index + 1} total={total} />
          </div>

          <div key={index} className="onboarding-carousel__slide">
            <img src={SLIDE_IMAGES[index]} alt="" className="onboarding-carousel__illustration" />
            <div className="onboarding-carousel__text">
              <h1 className="onboarding-carousel__heading">{slide.heading}</h1>
              <p className="onboarding-carousel__desc">{slide.desc}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="esim-sheet__footer">
        <Button
          variant="primary"
          label={isLast ? t.onboardingIntro.installNow : t.onboardingIntro.next}
          onClick={handleNext}
        />
      </div>
    </SheetShell>
  )
}
