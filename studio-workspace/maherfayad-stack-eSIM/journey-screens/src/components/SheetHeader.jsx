import { GlassButton } from '@alm-design/design-system'
import { useLanguage } from '../i18n/LanguageContext'
import './SheetHeader.css'

export default function SheetHeader({ title, onClose }) {
  const { t } = useLanguage()
  return (
    <div className="sheet-header">
      <div className="sheet-header__grabber-row">
        <span className="sheet-header__grabber" />
      </div>
      <div className="sheet-header__toolbar">
        <GlassButton bg="default" type="x" onClick={onClose} aria-label={t.common.close} />
        <p className="sheet-header__title">{title}</p>
        <div className="sheet-header__spacer" aria-hidden="true" />
      </div>
    </div>
  )
}
