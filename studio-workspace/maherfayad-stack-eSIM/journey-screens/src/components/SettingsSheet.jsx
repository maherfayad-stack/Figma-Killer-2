import { BottomSheet, SegmentedControl, ListItem } from '@alm-design/design-system'
import SectionTitle from './SectionTitle'
import './SettingsSheet.css'

export default function SettingsSheet({
  open,
  onClose,
  isDark,
  onThemeChange,
  lang,
  onLangChange,
  screens,
  active,
  onJumpTo,
  esimTab,
  onEsimTabChange,
  esimCardStyle,
  onEsimCardStyleChange,
  bannerStyle,
  onBannerStyleChange,
  introStyle,
  onIntroStyleChange,
}) {
  return (
    <BottomSheet
      className="settings-sheet"
      open={open}
      size="medium"
      platform="ios"
      title="Demo settings"
      subtitle="Two-finger tap or right-click to open"
      onClose={onClose}
    >
      <div className="settings-sheet__content">
        <div className="settings-sheet__section">
          <SectionTitle title="Appearance" size="compact" />
          <SegmentedControl
            items={['Light', 'Dark']}
            value={isDark ? 1 : 0}
            onChange={(index) => onThemeChange(index === 1)}
          />
        </div>

        <div className="settings-sheet__section">
          <SectionTitle title="Language" size="compact" />
          <SegmentedControl
            items={['EN', 'AR']}
            value={lang === 'ar' ? 1 : 0}
            onChange={(index) => onLangChange(index === 1 ? 'ar' : 'en')}
          />
        </div>

        <div className="settings-sheet__section">
          <SectionTitle title="eSIM state" size="compact" />
          <SegmentedControl
            items={['Install', 'Topup', 'Data']}
            value={esimTab}
            onChange={onEsimTabChange}
          />
        </div>

        <div className="settings-sheet__section">
          <SectionTitle title="Banner style" size="compact" />
          <SegmentedControl
            items={['Default', 'Tint', 'Row']}
            value={bannerStyle}
            onChange={onBannerStyleChange}
          />
        </div>

        <div className="settings-sheet__section">
          <SectionTitle title="Topup card style" size="compact" />
          <SegmentedControl
            items={['Ring', 'Stat', 'Gauge']}
            value={esimCardStyle}
            onChange={onEsimCardStyleChange}
          />
        </div>

        <div className="settings-sheet__section">
          <SectionTitle title="Install intro style" size="compact" />
          <SegmentedControl
            items={['Default', 'Onboarding']}
            value={introStyle}
            onChange={onIntroStyleChange}
          />
        </div>

        <div className="settings-sheet__section">
          <SectionTitle title="Screens" size="compact" />
          <div className="settings-sheet__list" role="list">
            {screens.map((screen) => (
              <ListItem
                key={screen.key}
                type="radio"
                name="settings-screen"
                selected={screen.key === active}
                label={screen.label}
                onChange={() => {
                  onJumpTo(screen.key)
                  onClose()
                }}
                onClick={() => {
                  if (screen.key === active) onClose()
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </BottomSheet>
  )
}
