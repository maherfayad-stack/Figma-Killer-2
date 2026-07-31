import { useState } from 'react'
import { Button, GlassButton, Radio, SegmentedControl } from '@alm-design/design-system'
import { useLanguage } from '../../i18n/LanguageContext'
import './SelectPackageSheet.css'

const DATA_PACKAGES = [
  { gb: 1, price: 20 },
  { gb: 3, price: 45 },
  { gb: 5, price: 70 },
  { gb: 10, price: 120 },
]

const DAYS_PACKAGES = [
  { days: 7, price: 15 },
  { days: 15, price: 25 },
  { days: 30, price: 40 },
]

function PackageCard({ name, label, price, selected, onChange, dir }) {
  return (
    <label className={`package-card${selected ? ' package-card--selected' : ''}`}>
      <Radio checked={selected} name={name} onChange={onChange} dir={dir} />
      <span className="package-card__value">{label}</span>
      <span className="package-card__price">{price}</span>
    </label>
  )
}

export default function SelectPackageSheet({ onClose, onConfirm }) {
  const { t, dir } = useLanguage()
  const [tab, setTab] = useState(0) // 0 = data, 1 = days
  const [selectedGb, setSelectedGb] = useState(null)
  const [selectedDays, setSelectedDays] = useState(null)

  const isData = tab === 0
  const selected = isData ? selectedGb : selectedDays

  const handleConfirm = () => {
    if (selected == null) return
    onConfirm?.(isData ? { type: 'data', value: selectedGb } : { type: 'days', value: selectedDays })
  }

  return (
    <div className="package-sheet" role="dialog" aria-modal="true">
      <div className="package-sheet__frame">
        <div className="package-sheet__scrim" onClick={onClose} aria-hidden="true" />
        <div className="package-sheet__panel">
          <button type="button" className="package-sheet__handle" onClick={onClose} aria-label={t.common.close}>
            <span className="package-sheet__grabber" />
          </button>

          <div className="package-sheet__header">
            <GlassButton bg="default" type="x" onClick={onClose} aria-label={t.common.close} />
            <p className="package-sheet__title">{t.topupPackage.title}</p>
            <div className="package-sheet__spacer" aria-hidden="true" />
          </div>

          <div className="package-sheet__content">
            <SegmentedControl
              items={[t.topupPackage.dataTab, t.topupPackage.daysTab]}
              value={tab}
              onChange={setTab}
              dir={dir}
            />

            <div className="package-sheet__list">
              {isData
                ? DATA_PACKAGES.map((pkg) => (
                    <PackageCard
                      key={pkg.gb}
                      name="topup-data-package"
                      label={t.topupPackage.gbLabel(pkg.gb)}
                      price={t.topupPackage.priceLabel(pkg.price)}
                      selected={selectedGb === pkg.gb}
                      onChange={() => setSelectedGb(pkg.gb)}
                      dir={dir}
                    />
                  ))
                : DAYS_PACKAGES.map((pkg) => (
                    <PackageCard
                      key={pkg.days}
                      name="topup-days-package"
                      label={t.topupPackage.daysLabel(pkg.days)}
                      price={t.topupPackage.priceLabel(pkg.price)}
                      selected={selectedDays === pkg.days}
                      onChange={() => setSelectedDays(pkg.days)}
                      dir={dir}
                    />
                  ))}
            </div>
          </div>

          <div className="package-sheet__footer">
            <Button
              variant="primary"
              label={t.common.confirm}
              onClick={handleConfirm}
              disabled={selected == null}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
