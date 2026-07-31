import { useState } from 'react'
import { Button, Cell } from '@alm-design/design-system'
import SheetShell from '../../components/SheetShell'
import ProgressSignal from '../../components/ProgressSignal'
import Icon from '../../components/Icon'
import EsimDataScreen from './EsimDataScreen'
import checkSvg from '@alm-design/design-system/src/icons/line-icons/check.svg?raw'
import questionCircleSvg from '@alm-design/design-system/src/icons/line-icons/infoCircle.svg?raw'
import headsetSvg from '@alm-design/design-system/src/icons/line-icons/headset.svg?raw'
import wifiSlashSvg from '@alm-design/design-system/src/icons/line-icons/wifiSlash.svg?raw'
import esimChip from '../../assets/esim-flow/figma/esim-chip.png'
import { useLanguage } from '../../i18n/LanguageContext'
import './esim-shared.css'
import './EsimSuccessScreen.css'

export default function EsimSuccessScreen({ heading, detail, onClose, onDone, stepLabel }) {
  const { t } = useLanguage()
  const [showDataHelp, setShowDataHelp] = useState(false)

  return (
    <>
      <SheetShell title={t.common.esimActivationTitle} onClose={onClose} className="esim-success">
        <div className="esim-sheet__scroll">
          <div className="esim-success__body">
            {stepLabel && (
              <div className="esim-success__progress">
                <ProgressSignal step={3} total={3} label={stepLabel} />
              </div>
            )}

            <div className="esim-success__hero">
              <div className="esim-success__badges">
                <span className="esim-success__sim-badge">
                  <img src={esimChip} alt="" width={40} height={40} />
                </span>
                <span className="esim-success__check-badge">
                  <Icon svg={checkSvg} size={32} style={{ color: 'var(--color-white-static)' }} />
                </span>
              </div>
              <div className="esim-success__copy">
                <p className="esim-success__heading">{heading}</p>
                <p className="esim-success__detail">{detail}</p>
              </div>
              <Button variant="primary-inverted" size="small" label={t.esimSuccess.primaryAction} onClick={onDone} />
            </div>

            <div className="esim-success__more">
              <p className="esim-success__more-title">{t.common.moreInformation}</p>
              <Cell
                icon={<Icon svg={questionCircleSvg} size={24} />}
                label={t.common.faqTitle}
                subtext={t.common.faqSubtext}
                trailing="chevron"
                showSeparator
              />
              <Cell
                icon={<Icon svg={headsetSvg} size={24} />}
                label={t.common.needHelp}
                trailing="chevron"
                showSeparator
              />
              <Cell
                icon={<Icon svg={wifiSlashSvg} size={24} />}
                label={t.esimData.moreInfoLabel}
                subtext={t.esimData.moreInfoSubtext}
                trailing="chevron"
                showSeparator={false}
                onClick={() => setShowDataHelp(true)}
              />
            </div>
          </div>
        </div>
      </SheetShell>

      {showDataHelp && (
        <EsimDataScreen onClose={() => setShowDataHelp(false)} onConfirm={() => setShowDataHelp(false)} />
      )}
    </>
  )
}
