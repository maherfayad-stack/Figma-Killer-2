import { Button } from '@alm-design/design-system'
import SheetShell from '../../components/SheetShell'
import ProgressSignal from '../../components/ProgressSignal'
import Icon from '../../components/Icon'
import checkSvg from '../../assets/icons/check.svg?raw'
import esimChip from '../../assets/esim-flow/figma/esim-chip.png'
import { useLanguage } from '../../i18n/LanguageContext'
import './esim-shared.css'
import './ActivateIntroScreen.css'

export default function ActivateIntroScreen({ onClose, onInstall }) {
  const { t } = useLanguage()
  return (
    <SheetShell title={t.common.esimActivationTitle} onClose={onClose} className="esim-intro">
      <div className="esim-sheet__scroll">
        <div className="esim-sheet__body">
          <div className="esim-intro__progress">
            <ProgressSignal step={1} total={4} label={t.activateIntro.stepLabel} />
          </div>

          <img src={esimChip} alt="" className="esim-intro__illustration" />

          <h1 className="esim-intro__heading">{t.activateIntro.heading}</h1>

          <ul className="esim-checklist">
            {t.common.esimChecklist.map((item) => (
              <li key={item} className="esim-checklist__row">
                <Icon svg={checkSvg} size={24} className="esim-checklist__icon" />
                <span className="esim-checklist__text">{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="esim-sheet__footer">
        <Button variant="primary" label={t.activateIntro.installEsim} onClick={onInstall} />
      </div>
    </SheetShell>
  )
}
