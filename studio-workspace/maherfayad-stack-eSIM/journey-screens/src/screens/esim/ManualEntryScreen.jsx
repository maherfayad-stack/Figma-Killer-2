import { useState } from 'react'
import { Button, GlassButton, TextInput, Snackbar } from '@alm-design/design-system'
import Icon from '../../components/Icon'
import copySvg from '../../assets/icons/copy.svg?raw'
import { useLanguage } from '../../i18n/LanguageContext'
import './ManualEntryScreen.css'

// Fallback for the SM-DP+/activation code details when install can't hand
// off to the OS eSIM flow automatically — user copies each value into their
// device's own "Add eSIM manually" screen. Small bottom sheet, same shape as
// SelectPackageSheet, popped over the current screen.
export default function ManualEntryScreen({ onClose, onConfirm }) {
  const { t, dir } = useLanguage()
  const m = t.manualEntry
  const [copied, setCopied] = useState(false)

  const copyValue = async (value) => {
    try {
      await navigator.clipboard?.writeText(value)
    } catch {
      // clipboard permission unavailable — the toast still confirms intent
    }
    setCopied(true)
  }

  const copyIcon = <Icon svg={copySvg} size={20} style={{ color: 'var(--icon-secondary-default)' }} />

  return (
    <div className="manual-entry-sheet" role="dialog" aria-modal="true">
      <div className="manual-entry-sheet__frame">
        <div className="manual-entry-sheet__scrim" onClick={onClose} aria-hidden="true" />
        <div className="manual-entry-sheet__panel">
          <button type="button" className="manual-entry-sheet__handle" onClick={onClose} aria-label={t.common.close}>
            <span className="manual-entry-sheet__grabber" />
          </button>

          <div className="manual-entry-sheet__header">
            <GlassButton bg="default" type="x" onClick={onClose} aria-label={t.common.close} />
            <p className="manual-entry-sheet__title">{m.title}</p>
            <div className="manual-entry-sheet__spacer" aria-hidden="true" />
          </div>

          <div className="manual-entry-sheet__content">
            <p className="manual-entry-sheet__description">{m.description}</p>

            <TextInput
              label={m.smdpLabel}
              value={m.smdpValue}
              readOnly
              trailingIcon={copyIcon}
              onClick={() => copyValue(m.smdpValue)}
              className="manual-entry-sheet__field"
            />

            <TextInput
              label={m.activationLabel}
              value={m.activationValue}
              readOnly
              helperText={m.activationHelper}
              trailingIcon={copyIcon}
              onClick={() => copyValue(m.activationValue)}
              className="manual-entry-sheet__field"
            />
          </div>

          <div className="manual-entry-sheet__footer">
            <Button variant="primary" label={t.common.confirm} onClick={onConfirm} />
          </div>
        </div>
      </div>

      <Snackbar message={m.copiedMessage} show={copied} duration={2000} onClose={() => setCopied(false)} dir={dir} />
    </div>
  )
}
