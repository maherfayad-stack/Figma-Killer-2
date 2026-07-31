import { ActionSheet } from '@alm-design/design-system'
import { useLanguage } from '../../i18n/LanguageContext'
import './DevicePickerSheet.css'

export default function DevicePickerSheet({ onThisDevice, onAnotherDevice, onClose }) {
  const { t } = useLanguage()
  return (
    <div className="esim-device-picker">
      <ActionSheet
        platform="ios"
        title={t.devicePicker.title}
        actions={[
          { label: t.devicePicker.thisDevice, onClick: onThisDevice },
          { label: t.devicePicker.anotherDevice, onClick: onAnotherDevice },
        ]}
        onClose={onClose}
      />
    </div>
  )
}
