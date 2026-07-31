import { Button, GlassButton } from '@alm-design/design-system'
import Icon from '../../components/Icon'
import checkSvg from '../../assets/icons/check.svg?raw'
import { useLanguage } from '../../i18n/LanguageContext'
import './esim-shared.css'
import './EsimDataScreen.css'

// Troubleshooting screen for when the installed eSIM isn't getting data —
// walks the user through turning on mobile data / roaming for it manually.
// Small bottom sheet, same shape as SelectPackageSheet, popped over the
// current screen.
export default function EsimDataScreen({ onClose, onConfirm, onContactSupport }) {
  const { t } = useLanguage()
  const d = t.esimData

  return (
    <div className="esim-data-sheet" role="dialog" aria-modal="true">
      <div className="esim-data-sheet__frame">
        <div className="esim-data-sheet__scrim" onClick={onClose} aria-hidden="true" />
        <div className="esim-data-sheet__panel">
          <button type="button" className="esim-data-sheet__handle" onClick={onClose} aria-label={t.common.close}>
            <span className="esim-data-sheet__grabber" />
          </button>

          <div className="esim-data-sheet__header">
            <GlassButton bg="default" type="x" onClick={onClose} aria-label={t.common.close} />
            <p className="esim-data-sheet__title">{d.title}</p>
            <div className="esim-data-sheet__spacer" aria-hidden="true" />
          </div>

          <div className="esim-data-sheet__content">
            <div className="esim-data-sheet__copy">
              <h1 className="esim-data-sheet__heading">{d.heading}</h1>
              <p className="esim-data-sheet__subtext">{d.subtext}</p>
            </div>

            <ul className="esim-checklist">
              {d.steps.map((step) => (
                <li key={step} className="esim-checklist__row">
                  <Icon svg={checkSvg} size={24} className="esim-checklist__icon" />
                  <span className="esim-checklist__text">{step}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="esim-data-sheet__footer">
            <Button variant="primary" label={d.confirm} onClick={onConfirm} />
            <button type="button" className="esim-data-sheet__contact" onClick={onContactSupport}>
              {d.contact}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
