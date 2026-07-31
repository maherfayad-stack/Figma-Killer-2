import { useCallback, useEffect, useState } from 'react'
import { DesignSystemProvider, SegmentedControl } from '@alm-design/design-system'
import BookingConfirmationScreen from './screens/BookingConfirmationScreen'
import HomepageScreen from './screens/HomepageScreen'
import BookingDetailsScreen from './screens/BookingDetailsScreen'
import ActivationFlowScreen from './screens/esim/ActivationFlowScreen'
import TopupFlowScreen from './screens/esim/TopupFlowScreen'
import DevicePickerSheet from './screens/esim/DevicePickerSheet'
import SelectPackageSheet from './screens/esim/SelectPackageSheet'
import EsimDataScreen from './screens/esim/EsimDataScreen'
import CanvasPanel from './components/CanvasPanel'
import SettingsSheet from './components/SettingsSheet'
import useIsMobile from './hooks/useIsMobile'
import useSettingsGesture from './hooks/useSettingsGesture'
import { LanguageProvider, useLanguage } from './i18n/LanguageContext'
import { getUrlParam, setUrlParams } from './urlState'
import './App.css'

const SCREENS = [
  { key: 'homepage', label: 'Home page', Component: HomepageScreen },
  { key: 'booking-confirmation', label: 'Confirmation', Component: BookingConfirmationScreen },
  { key: 'booking-details', label: 'Booking details', Component: BookingDetailsScreen },
]

export default function App() {
  return (
    <LanguageProvider>
      <AppShell />
    </LanguageProvider>
  )
}

function AppShell() {
  const { lang, dir, toggleLang, t } = useLanguage()
  const [active, setActive] = useState(() => {
    const p = getUrlParam('page')
    return SCREENS.some((s) => s.key === p) ? p : SCREENS[0].key
  })
  const [isDark, setIsDark] = useState(() => getUrlParam('theme') === 'dark')
  const [view, setView] = useState('flow') // 'flow' | 'canvas'
  const [sheetOpen, setSheetOpen] = useState(false)
  // Action-sheet style popups that sit on top of the current tab's screen.
  const [popup, setPopup] = useState(null) // null | 'device-picker' | 'package-sheet' | 'esim-data'
  // Full-screen flows that replace the current tab's screen while active.
  const [flow, setFlow] = useState(null) // null | 'activate' | 'topup'
  const [activateStep, setActivateStep] = useState('intro') // 'intro' | 'qr' — entry point once a device is chosen
  const [esimScrollTick, setEsimScrollTick] = useState(0)
  // The GB/Days package the user picked in SelectPackageSheet, carried into
  // TopupFlowScreen so the success screen can show what was actually bought.
  const [topupPackage, setTopupPackage] = useState(null)
  // Demo-only state switcher for the eSIM install/topup card states — shared
  // across Home page and Booking details so navigating between them stays coherent.
  const [esimDemoTab, setEsimDemoTab] = useState(() => {
    const p = getUrlParam('esim')
    return p === 'topup' ? 1 : p === 'data' ? 2 : 0
  })
  // Demo-only visual variant for the "purchased add-ons" topup cards — control lives
  // in the settings sheet (mobile) and the desktop top nav (booking details only).
  const [esimCardStyle, setEsimCardStyle] = useState(() => {
    const c = getUrlParam('card')
    return c === 'stat' ? 1 : c === 'gauge' ? 2 : 0
  })
  // Demo-only visual variant for the install/topup banners — control lives in the
  // settings sheet (mobile) and the desktop top nav, not the mobile floating action row.
  const [bannerStyle, setBannerStyle] = useState(() => {
    const b = getUrlParam('banner')
    return b === 'tint' ? 1 : b === 'row' ? 2 : 0
  })
  // Demo-only toggle for the "install" entry point — 0 keeps the existing
  // checklist intro, 1 swaps in the animated 3-slide onboarding carousel.
  // Real-world behavior: the carousel is a one-time tutorial, so it only
  // shows the very first time "This device" is picked after the toggle is
  // turned on; every install after that falls back to the checklist. Flipping
  // the toggle off and back on re-arms it, which doubles as a "replay" control
  // for demoing it more than once.
  const [introStyle, setIntroStyle] = useState(() => (getUrlParam('intro') === 'onboarding' ? 1 : 0))
  const [onboardingSeen, setOnboardingSeen] = useState(false)
  const [activateIntroVariant, setActivateIntroVariant] = useState('checklist')
  const current = SCREENS.find((s) => s.key === active)
  const isMobile = useIsMobile()
  const showEsimDemoTabs = (active === 'homepage' || active === 'booking-details') && !flow
  const showCardStyleControl = active === 'booking-details' && !flow

  // Keep the URL query string in sync with the demo state so the current page,
  // language, theme, and chosen variants are all shareable/bookmarkable, and
  // survive a reload.
  useEffect(() => {
    setUrlParams({
      page: active,
      lang,
      theme: isDark ? 'dark' : 'light',
      esim: esimDemoTab === 1 ? 'topup' : esimDemoTab === 2 ? 'data' : 'install',
      banner: bannerStyle === 1 ? 'tint' : bannerStyle === 2 ? 'row' : 'default',
      card: esimCardStyle === 1 ? 'stat' : esimCardStyle === 2 ? 'gauge' : 'ring',
      intro: introStyle === 1 ? 'onboarding' : 'default',
    })
  }, [active, lang, isDark, esimDemoTab, bannerStyle, esimCardStyle, introStyle])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light')
  }, [isDark])

  useEffect(() => {
    document.documentElement.setAttribute('dir', dir)
    document.documentElement.setAttribute('lang', lang)
  }, [dir, lang])

  const jumpTo = useCallback((key) => {
    setActive(key)
    setView('flow')
    setPopup(null)
    setFlow(null)
  }, [])

  const goToEsims = useCallback(() => {
    setActive('booking-details')
    setView('flow')
    setPopup(null)
    setFlow(null)
    setEsimScrollTick((t) => t + 1)
  }, [])

  const consumeScrollSignal = useCallback(() => setEsimScrollTick(0), [])

  const openInstallPicker = useCallback(() => setPopup('device-picker'), [])
  const openTopupSheet = useCallback(() => setPopup('package-sheet'), [])
  const openDataHelp = useCallback(() => setPopup('esim-data'), [])
  const closePopup = useCallback(() => setPopup(null), [])
  const closeFlow = useCallback(() => setFlow(null), [])

  const onThisDevice = useCallback(() => {
    setPopup(null)
    setActivateStep('intro')
    setFlow('activate')
    const showOnboarding = introStyle === 1 && !onboardingSeen
    setActivateIntroVariant(showOnboarding ? 'onboarding' : 'checklist')
    if (showOnboarding) setOnboardingSeen(true)
  }, [introStyle, onboardingSeen])

  const handleIntroStyleChange = useCallback((next) => {
    setIntroStyle(next)
    setOnboardingSeen(false)
  }, [])
  const onAnotherDevice = useCallback(() => {
    setPopup(null)
    setActivateStep('qr')
    setFlow('activate')
  }, [])
  const onPackageConfirm = useCallback((pkg) => {
    setTopupPackage(pkg)
    setPopup(null)
    setFlow('topup')
  }, [])

  let Screen
  let screenProps = { onClose: () => {} }
  let popupNode = null
  if (flow === 'activate') {
    Screen = ActivationFlowScreen
    screenProps = { onExit: closeFlow, initialStep: activateStep, introVariant: activateIntroVariant }
  } else if (flow === 'topup') {
    Screen = TopupFlowScreen
    screenProps = { onExit: closeFlow, packageInfo: topupPackage }
  } else {
    Screen = current.Component
    if (active === 'homepage') {
      screenProps = { onViewEsims: goToEsims, onTopup: goToEsims, esimTab: esimDemoTab, bannerStyle }
    } else if (active === 'booking-details') {
      screenProps = {
        onClose: () => {},
        onInstall: openInstallPicker,
        onTopup: openTopupSheet,
        onDataHelp: openDataHelp,
        scrollToEsimSignal: esimScrollTick,
        onScrolled: consumeScrollSignal,
        esimTab: esimDemoTab,
        esimCardStyle,
        bannerStyle,
      }
    }

    if (popup === 'device-picker') {
      popupNode = (
        <DevicePickerSheet onThisDevice={onThisDevice} onAnotherDevice={onAnotherDevice} onClose={closePopup} />
      )
    } else if (popup === 'package-sheet') {
      popupNode = <SelectPackageSheet onClose={closePopup} onConfirm={onPackageConfirm} />
    } else if (popup === 'esim-data') {
      popupNode = <EsimDataScreen onClose={closePopup} onConfirm={closePopup} />
    }
  }

  const openSheet = useCallback(() => setSheetOpen(true), [])
  const closeSheet = useCallback(() => setSheetOpen(false), [])
  const gestures = useSettingsGesture(openSheet)

  const esimDemoTabs = showEsimDemoTabs ? (
    <SegmentedControl
      items={[t.common.install, t.common.topup, t.common.dataTabLabel]}
      value={esimDemoTab}
      onChange={setEsimDemoTab}
      className="esim-demo-tabs"
    />
  ) : null

  const bannerStyleControl = showEsimDemoTabs ? (
    <SegmentedControl
      items={['Default', 'Tint', 'Row']}
      value={bannerStyle}
      onChange={setBannerStyle}
      className="esim-demo-tabs esim-banner-style-tabs"
    />
  ) : null

  const cardStyleControl = showCardStyleControl ? (
    <SegmentedControl
      items={['Ring', 'Stat', 'Gauge']}
      value={esimCardStyle}
      onChange={setEsimCardStyle}
      className="esim-demo-tabs esim-card-style-tabs"
    />
  ) : null

  const settingsSheet = (
    <SettingsSheet
      open={sheetOpen}
      onClose={closeSheet}
      isDark={isDark}
      onThemeChange={setIsDark}
      lang={lang}
      onLangChange={(next) => next !== lang && toggleLang()}
      screens={SCREENS}
      active={active}
      onJumpTo={jumpTo}
      esimTab={esimDemoTab}
      onEsimTabChange={setEsimDemoTab}
      esimCardStyle={esimCardStyle}
      onEsimCardStyleChange={setEsimCardStyle}
      bannerStyle={bannerStyle}
      onBannerStyleChange={setBannerStyle}
      introStyle={introStyle}
      onIntroStyleChange={handleIntroStyleChange}
    />
  )

  if (isMobile) {
    return (
      <DesignSystemProvider dir={dir}>
      <div className="esim-app esim-app--mobile">
        <div
          className="esim-mobile"
          onContextMenuCapture={gestures.handleContextMenuCapture}
          onPointerDownCapture={gestures.handlePointerDownCapture}
          onPointerUpCapture={gestures.handlePointerUpCapture}
          onPointerCancelCapture={gestures.handlePointerCancelCapture}
        >
          <div className="esim-mobile__actions">
            {esimDemoTabs}
            <button type="button" className="esim-mobile__menu-btn" onClick={openSheet} aria-label="Settings">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>

          <Screen key={flow ? `flow-${flow}` : active} {...screenProps} />
          {popupNode}
        </div>

        {settingsSheet}
      </div>
      </DesignSystemProvider>
    )
  }

  return (
    <DesignSystemProvider dir={dir}>
    <div className="esim-app">
      <header className="esim-bar">
        <div className="esim-bar__left">
          <span className="esim-bar__title">
            Journey <span>Screens</span>
          </span>
        </div>

        <div className="esim-bar__right">
          <button type="button" className="esim-lang-btn" onClick={toggleLang} title="Switch language">
            {lang === 'en' ? 'AR' : 'EN'}
          </button>

          <button type="button" className="esim-icon-btn" onClick={() => setIsDark((d) => !d)} title="Toggle theme">
            {isDark ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>

          <button
            type="button"
            className={['esim-icon-btn', 'esim-canvas-btn', view === 'canvas' ? 'esim-canvas-btn--active' : ''].filter(Boolean).join(' ')}
            onClick={() => setView((v) => (v === 'canvas' ? 'flow' : 'canvas'))}
          >
            Canvas
          </button>

          <button
            type="button"
            className={['esim-icon-btn', 'esim-canvas-btn', introStyle === 1 ? 'esim-canvas-btn--active' : ''].filter(Boolean).join(' ')}
            onClick={() => handleIntroStyleChange(introStyle === 1 ? 0 : 1)}
            title="Toggle the animated onboarding intro (one-time on first install)"
          >
            New intro
          </button>
        </div>
      </header>

      {view !== 'canvas' && (
        <nav className="esim-page-tabs">
          {SCREENS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={['esim-page-tab', active === s.key ? 'esim-page-tab--active' : ''].filter(Boolean).join(' ')}
              onClick={() => {
                setActive(s.key)
                setPopup(null)
                setFlow(null)
              }}
            >
              {s.label}
            </button>
          ))}
        </nav>
      )}

      {view !== 'canvas' && esimDemoTabs && (
        <div className="esim-demo-tabs-row">
          {esimDemoTabs}
          {bannerStyleControl}
          {cardStyleControl}
        </div>
      )}

      {view === 'canvas' ? (
        <div className="esim-canvas-shell">
          <CanvasPanel screens={SCREENS} onJumpTo={jumpTo} onClose={() => setView('flow')} active={view === 'canvas'} />
        </div>
      ) : (
        <div className="esim-stage">
          <div
            className="esim-phone"
            onContextMenuCapture={gestures.handleContextMenuCapture}
            onPointerDownCapture={gestures.handlePointerDownCapture}
            onPointerUpCapture={gestures.handlePointerUpCapture}
            onPointerCancelCapture={gestures.handlePointerCancelCapture}
          >
            <Screen key={flow ? `flow-${flow}` : active} {...screenProps} />
            {popupNode}
          </div>
        </div>
      )}

      {settingsSheet}
    </div>
    </DesignSystemProvider>
  )
}
