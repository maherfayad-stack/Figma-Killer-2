import { useState } from 'react'
import { Button } from '@alm-design/design-system'
import SheetShell from '../../components/SheetShell'
import ProgressSignal from '../../components/ProgressSignal'
import EsimConfiguringLoader from '../../components/EsimConfiguringLoader'
import StaticScreenshotScreen from './StaticScreenshotScreen'
import ManualEntryScreen from './ManualEntryScreen'
import esimOwn from '../../assets/esim-flow/figma/settings-phone-mockup.png'
import settingsCellularPopup from '../../assets/esim-flow/figma/settings-cellular-popup.png'
import settingsConnecting from '../../assets/esim-flow/figma/settings-connecting.png'
import { useLanguage } from '../../i18n/LanguageContext'
import './esim-shared.css'
import './ActivateSettingsScreen.css'

export default function ActivateSettingsScreen({ onClose, onDone }) {
  const { t } = useLanguage()
  const [stage, setStage] = useState('ready') // 'ready' | 'cellular-popup' | 'connecting' | 'loading'
  const [showManual, setShowManual] = useState(false)

  if (stage === 'cellular-popup') {
    return (
      <StaticScreenshotScreen
        src={settingsCellularPopup}
        alt={t.activateSettings.cellularPopupAlt}
        onClick={() => setStage('connecting')}
      />
    )
  }

  if (stage === 'connecting') {
    return (
      <StaticScreenshotScreen
        src={settingsConnecting}
        alt={t.activateSettings.connectingAlt}
        onClick={() => setStage('loading')}
      />
    )
  }

  return (
    <>
      <SheetShell title={t.common.esimActivationTitle} onClose={onClose} className="esim-settings">
        <div className="esim-sheet__scroll">
          <div className="esim-sheet__body">
            <div className="esim-intro__progress">
              <ProgressSignal step={2} total={4} label={t.activateSettings.stepLabel} />
            </div>

            <img src={esimOwn} alt="" className="esim-settings__phone" />

            <div className="esim-settings__copy">
              <h1 className="esim-settings__heading">{t.activateSettings.heading}</h1>
              <p className="esim-settings__subtext">
                {t.activateSettings.subtext}
              </p>
            </div>
          </div>
        </div>

        <div className="esim-sheet__footer">
          {stage === 'ready' ? (
            <div className="esim-settings__actions">
              <Button variant="primary" label={t.activateSettings.openSettings} onClick={() => setStage('cellular-popup')} />
              <Button variant="secondary" label={t.activateSettings.manualEntry} onClick={() => setShowManual(true)} />
            </div>
          ) : (
            <EsimConfiguringLoader
              title={t.activateSettings.configuring}
              phases={t.activateSettings.phases}
              onDone={onDone}
            />
          )}
        </div>
      </SheetShell>

      {showManual && (
        <ManualEntryScreen
          onClose={() => setShowManual(false)}
          onConfirm={() => {
            setShowManual(false)
            setStage('loading')
          }}
        />
      )}
    </>
  )
}
