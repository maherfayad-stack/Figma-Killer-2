import { useCallback, useEffect, useState } from 'react'
import CanvasPanel from './CanvasPanel'
import ScreenFrame from './ScreenFrame'
import Player from './Player'
import { BOARDS, FRAME_DEFAULTS, PREVIEW_AXES, PROJECT_NAME, SCREENS, applyColorSchemeGate } from './registry.generated'
import { Providers, useShellLanguage } from './providers.generated'
import { getUrlParams, setUrlParams } from './urlState'

const SCREEN_BY_ID = Object.fromEntries(SCREENS.map((screen) => [screen.key, screen]))

/**
 * The whole prototype: a board tab row, a pan/zoom canvas, and a flow view
 * showing one screen at device size.
 *
 * Studio's board IS the source of the layout — boards become tabs, and a
 * board's frames keep the x/y the author arranged them at. Nothing here
 * re-lays-out the design.
 *
 * This file is yours: Studio writes it once and never again. The two files it
 * does keep in step are the `.generated` ones this imports.
 */
export default function App() {
  const params = getUrlParams()
  const [boardId, setBoardId] = useState(params.board || (BOARDS[0] && BOARDS[0].id) || null)
  const [pageId, setPageId] = useState(params.page || null)
  const [view, setView] = useState(params.view === 'flow' && params.page ? 'flow' : 'canvas')
  const [theme, setTheme] = useState(params.theme || PREVIEW_AXES.colorScheme || 'light')

  const board = BOARDS.find((entry) => entry.id === boardId) || BOARDS[0] || null

  useEffect(() => {
    setUrlParams({ board: boardId, page: view === 'flow' ? pageId : null, view, theme })
  }, [boardId, pageId, view, theme])

  // The colour scheme is applied the way the project's own CSS gates it —
  // `data-theme`, a class, or nothing — plus `color-scheme` so form controls
  // and scrollbars follow. See `applyColorSchemeGate` in the generated
  // registry for where that gate came from.
  useEffect(() => {
    const html = document.documentElement
    html.setAttribute('data-theme', theme)
    html.style.colorScheme = theme
    applyColorSchemeGate(html, theme)
  }, [theme])

  const openFrame = useCallback((frame) => {
    setPageId(frame.pageId)
    setView('flow')
  }, [])

  return (
    <Providers>
      <Shell
        board={board}
        boardId={board ? board.id : null}
        onBoard={setBoardId}
        pageId={pageId}
        onPage={setPageId}
        view={view}
        onView={setView}
        theme={theme}
        onTheme={setTheme}
        onOpenFrame={openFrame}
      />
    </Providers>
  )
}

/**
 * Split from `App` so it sits INSIDE `Providers` and can therefore read the
 * language context — the language control has to be able to call `setLang`,
 * which only exists below the provider.
 */
function Shell({ board, boardId, onBoard, pageId, onPage, view, onView, theme, onTheme, onOpenFrame }) {
  const { lang, dir, setLang, locales } = useShellLanguage()
  // Only consulted below 700px, where the toolbar is hidden by default. See the
  // media query in shell.css for why the chrome gets out of the way there.
  const [chromeOpen, setChromeOpen] = useState(false)

  // `dir` on <html> is what CSS mirrors from. The design system's own
  // components resolve direction in JavaScript instead, which is what
  // `Providers` handles — both halves have to agree or a screen comes out
  // half-mirrored.
  useEffect(() => {
    document.documentElement.setAttribute('dir', dir)
    if (lang) document.documentElement.setAttribute('lang', lang)
  }, [dir, lang])

  const frames = board ? board.frames : []
  const screen = pageId ? SCREEN_BY_ID[pageId] : null

  // Which screen "Flow" means when you have not picked one yet: the first
  // frame on the board you are looking at, so the view opens on something you
  // can already see. Falls back to the first screen for a board with no frames.
  const firstFrame = frames.find((frame) => SCREEN_BY_ID[frame.pageId])
  const fallbackPageId = firstFrame ? firstFrame.pageId : (SCREENS[0] ? SCREENS[0].key : null)

  // The wordmark, split so the last word can take the accent. Split on
  // non-alphanumerics so 'travel-essentials' and 'Travel Essentials' read the
  // same; a one-word name simply has no accented half.
  const nameParts = String(PROJECT_NAME || 'Prototype').split(/[^A-Za-z0-9]+/).filter(Boolean)
  const titleTail = nameParts.length > 1 ? nameParts[nameParts.length - 1] : ''
  const titleHead = nameParts.length > 1 ? nameParts.slice(0, -1).join(' ') : nameParts.join(' ')

  // The language the button would switch you TO. Cycles, so three locales work
  // as well as two without a different control.
  const otherLocale = locales.length > 1
    ? locales[(locales.indexOf(lang) + 1) % locales.length]
    : null

  return (
    <div className="shell" data-chrome={chromeOpen ? 'open' : 'closed'}>
      {/* dir="ltr" on the CHROME, not the content. `dir` on <html> is what
          mirrors the screens, and it would otherwise mirror the toolbar with
          them — the wordmark and the Canvas button jumping to the other side of
          the window every time you preview Arabic. The tool stays put; the
          design mirrors. */}
      <div className="shell__chrome" dir="ltr">
        <header className="shell__bar">
          <span className="shell__title">
            {titleHead}
            {titleTail ? <em> {titleTail}</em> : null}
          </span>

          <span className="shell__spacer" />

          {/* Shows the language you would GET, not the one you are in — a
              control labelled with the current state reads as a status
              readout, and gets clicked expecting nothing to happen. */}
          {otherLocale && (
            <button type="button" className="shell__btn" onClick={() => setLang(otherLocale)}>
              {otherLocale.toUpperCase()}
            </button>
          )}

          <button
            type="button"
            className="shell__btn shell__btn--icon"
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={() => onTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>

          {/* One button, not a Canvas/Flow pair. It reports where you are with
              aria-pressed and takes you to the other place — which is the
              whole of what the pair did, minus the dead half. Disabled only
              when the project has no screens, where neither view has anything
              to show. */}
          <button
            type="button"
            className="shell__btn"
            aria-pressed={view === 'canvas' ? 'true' : 'false'}
            disabled={!screen && !fallbackPageId}
            onClick={() => {
              if (view === 'canvas') {
                if (!screen && fallbackPageId) onPage(fallbackPageId)
                onView('flow')
              } else {
                onView('canvas')
              }
            }}
          >
            Canvas
          </button>
        </header>

        {/* The screens. Hidden on the canvas, which already draws every one of
            them — a picker for something wholly on screen is noise. */}
        {view !== 'canvas' && SCREENS.length > 0 && (
          <nav className="shell__nav" aria-label="Screens">
            {SCREENS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                aria-current={entry.key === pageId ? 'true' : undefined}
                onClick={() => onPage(entry.key)}
              >
                {entry.label}
              </button>
            ))}
          </nav>
        )}

        {/* Which board the flow view is drawing from. Only when there is a
            choice: a labelled row offering one option is a caption pretending
            to be a control. */}
        {view !== 'canvas' && BOARDS.length > 1 && (
          <nav className="shell__nav shell__nav--group" aria-label="Boards">
            <span className="shell__nav-label">Boards</span>
            {BOARDS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-current={entry.id === boardId ? 'true' : undefined}
                onClick={() => { onBoard(entry.id) }}
              >
                {entry.name}
              </button>
            ))}
          </nav>
        )}
      </div>

      {view === 'canvas' ? (
        <CanvasPanel
          rows={BOARDS.map((entry) => ({
            key: entry.id,
            title: entry.name,
            frames: entry.frames.filter((frame) => SCREEN_BY_ID[frame.pageId]),
            notes: entry.notes,
            docs: entry.docs,
          }))}
          renderFrame={(frame) => <FramePreview frame={frame} dir={dir} lang={lang} theme={theme} />}
          onOpenFrame={onOpenFrame}
          onClose={
            fallbackPageId
              ? () => {
                  if (!screen) onPage(fallbackPageId)
                  onView('flow')
                }
              : null
          }
        />
      ) : (
        <div className="shell__stage">
          {screen ? (
            <div
              className="shell__phone"
              style={{ '--device-w': FRAME_DEFAULTS.width + 'px', '--device-h': FRAME_DEFAULTS.height + 'px' }}
            >
              {/* The Player, not a bare ScreenFrame: this is where the links
                  authored on the board actually run. */}
              <Player pageId={pageId} onPageChange={onPage} dir={dir} lang={lang} theme={theme} />
            </div>
          ) : (
            <p className="shell__empty">Pick a screen on the canvas to open it here.</p>
          )}
        </div>
      )}

      {/* Hidden on desktop by CSS. On a phone it is the only way back to the
          board tabs, language and theme once the chrome is out of the way. */}
      <button
        type="button"
        className="shell__chrome-toggle"
        aria-expanded={chromeOpen ? 'true' : 'false'}
        aria-label={chromeOpen ? 'Hide prototype controls' : 'Show prototype controls'}
        onClick={() => setChromeOpen((open) => !open)}
      >
        {chromeOpen ? '✕' : '☰'}
      </button>
    </div>
  )
}

/**
 * One board frame's live screen, in a viewport the size of that frame.
 *
 * A frame can override the board's direction or colour scheme per axis — the
 * "duplicate as RTL" / "duplicate as Dark" frames Studio authors. Those
 * overrides are carried here so a board can show both at once, which is the
 * whole point of having them.
 *
 * They now land on the preview's own document rather than on a wrapper div, so
 * an RTL frame gets 'dir' where the real device would have it. The frame's
 * width and height become the viewport, which is what stops a page written
 * against '100vh' from being measured against the browser window instead. See
 * ScreenFrame.jsx.
 */
function FramePreview({ frame, dir, lang, theme }) {
  const screen = SCREEN_BY_ID[frame.pageId]
  if (!screen) return null
  const axes = frame.axes || {}
  return (
    <ScreenFrame
      width={frame.width}
      height={frame.height}
      dir={axes.direction || dir}
      lang={lang}
      theme={axes.colorScheme || theme}
      title={frame.label}
    >
      <screen.Component />
    </ScreenFrame>
  )
}
