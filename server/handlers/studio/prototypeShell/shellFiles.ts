/**
 * shellFiles — the static half of the preview shell Studio scaffolds into a
 * workspace: the files that are the SAME for every project.
 *
 * Embedded as template literals rather than copied from an asset directory,
 * matching `pageTemplates.ts`'s `starterPage` — the established shape for
 * "source Studio writes into a user's project" in this codebase.
 *
 * ## What the shell is, and what it is not
 *
 * The workspace already holds the design: `pages/`, `components/`, `i18n/`.
 * What it has never held is a way to RUN it — no `index.html`, no entry
 * module, no board. So "Download the code" produced a pile of components that
 * cannot start, and everything the canvas knows (boards, frame geometry,
 * direction, colour scheme) stayed behind in `.studio/`, which the download
 * deliberately excludes.
 *
 * This shell is the viewer for that design, not a re-expression of it. Not one
 * byte of a user's page is generated, rewritten, or read by it — it imports
 * them and puts them on a board. That is the line that keeps "the repository
 * IS the document" true: we generate the harness, never the document.
 *
 * ## Written once, then yours
 *
 * Every file here is written only when ABSENT. Edit `App.jsx` and Studio will
 * never touch it again. The two files Studio does keep in step end in
 * `.generated.jsx` and say so at the top — see `registryFile.ts`.
 *
 * ## No backticks below, on purpose
 *
 * These templates are themselves template literals, so every backtick and
 * every `${` in the emitted source would need escaping — and an escaping slip
 * produces a file that is broken in the user's project rather than in a test.
 * The emitted code therefore composes class names with `.join(' ')` and never
 * uses a template literal of its own.
 */

import { canvasShellFiles } from './canvasTemplate'
import { screenFrameFile } from './screenFrameTemplate'
import { PROTOTYPE_SHELL_DIR, type ShellFile } from './shellPaths'
import { SHELL_CSS } from './shellCssTemplate'

export { PROTOTYPE_SHELL_DIR, type ShellFile } from './shellPaths'

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Prototype</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/prototype/main.jsx"></script>
  </body>
</html>
`

const VITE_CONFIG = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The workspace root IS the app root: pages/, components/ and i18n/ sit
// beside this file, exactly as Studio reads them.
export default defineConfig({
  plugins: [react()],
  server: { open: true },
})
`

const MAIN_JSX = `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './shell.css'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`

const URL_STATE_JS = `// The shell's state in the query string, so a board, a screen, a language and
// a theme are all shareable as a link and survive a reload.

export function getUrlParams() {
  if (typeof window === 'undefined') return {}
  const params = new URLSearchParams(window.location.search)
  const out = {}
  for (const [key, value] of params.entries()) out[key] = value
  return out
}

export function setUrlParams(next) {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  for (const key of Object.keys(next)) {
    const value = next[key]
    if (value == null) url.searchParams.delete(key)
    else url.searchParams.set(key, String(value))
  }
  window.history.replaceState(null, '', url)
}
`

const APP_JSX = `import { useCallback, useEffect, useRef, useState } from 'react'
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
 * does keep in step are the \`.generated\` ones this imports.
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
  // \`data-theme\`, a class, or nothing — plus \`color-scheme\` so form controls
  // and scrollbars follow. See \`applyColorSchemeGate\` in the generated
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
 * Split from \`App\` so it sits INSIDE \`Providers\` and can therefore read the
 * language context — the language control has to be able to call \`setLang\`,
 * which only exists below the provider.
 */
function Shell({ board, boardId, onBoard, pageId, onPage, view, onView, theme, onTheme, onOpenFrame }) {
  const { lang, dir, setLang, locales } = useShellLanguage()
  // The settings sheet. Reachable only below 700px, where the bar is replaced
  // rather than shrunk — see the media query in shell.css for why.
  const [sheetOpen, setSheetOpen] = useState(false)

  // \`dir\` on <html> is what CSS mirrors from. The design system's own
  // components resolve direction in JavaScript instead, which is what
  // \`Providers\` handles — both halves have to agree or a screen comes out
  // half-mirrored.
  useEffect(() => {
    document.documentElement.setAttribute('dir', dir)
    if (lang) document.documentElement.setAttribute('lang', lang)
  }, [dir, lang])

  // The language is the one piece of shell state living BELOW the provider, so
  // it is synced here rather than in App's url effect — which is exactly why
  // it was being dropped: that effect rewrote the query string without it, so
  // '?lang=ar' was wiped on load and a shared link always opened in the
  // project's default, despite urlState.js promising a shareable language.
  const urlLangApplied = useRef(false)
  useEffect(() => {
    if (!urlLangApplied.current) {
      urlLangApplied.current = true
      const wanted = getUrlParams().lang
      // Only a locale the project declares. A stray '?lang=xx' must not put the
      // provider into a language it has no dictionary for.
      if (wanted && wanted !== lang && locales.indexOf(wanted) !== -1) {
        setLang(wanted)
        return
      }
    }
    setUrlParams({ lang })
  }, [lang, locales, setLang])

  // Escape closes the sheet. A modal you can only leave by hitting a 28px
  // target is a modal that traps a keyboard.
  useEffect(() => {
    if (!sheetOpen) return undefined
    const onKey = (event) => { if (event.key === 'Escape') setSheetOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sheetOpen])

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
    <div className="shell">
      {/* dir="ltr" on the CHROME, not the content. \`dir\` on <html> is what
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

      {/* Hidden on desktop by CSS. On a phone the bar is gone entirely, so this
          is the only way to language, theme, view and screens. */}
      <button
        type="button"
        className="shell__gear"
        aria-expanded={sheetOpen ? 'true' : 'false'}
        aria-label="Prototype settings"
        onClick={() => setSheetOpen(true)}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {/* Everything the bar holds, as a sheet. Rendered on every viewport and
          hidden on desktop by the gear's own display rule — one control tree,
          not a phone copy of the bar that has to be kept in step with it. */}
      {sheetOpen && (
        <div className="shell__sheet" role="dialog" aria-modal="true" aria-label="Prototype settings">
          <button
            type="button"
            className="shell__sheet-scrim"
            aria-label="Close settings"
            onClick={() => setSheetOpen(false)}
          />
          <div className="shell__sheet-panel">
            <div className="shell__sheet-grabber" />
            <div className="shell__sheet-head">
              <button
                type="button"
                className="shell__sheet-close"
                aria-label="Close settings"
                onClick={() => setSheetOpen(false)}
              >
                {'\u2715'}
              </button>
              <p className="shell__sheet-title">{titleHead}{titleTail ? ' ' + titleTail : ''}</p>
              <p className="shell__sheet-sub">Prototype settings</p>
            </div>

            <div className="shell__sheet-body">
              <section>
                <h3 className="shell__sheet-label">Appearance</h3>
                <div className="shell__seg">
                  <button type="button" aria-pressed={theme === 'light' ? 'true' : 'false'} onClick={() => onTheme('light')}>Light</button>
                  <button type="button" aria-pressed={theme === 'dark' ? 'true' : 'false'} onClick={() => onTheme('dark')}>Dark</button>
                </div>
              </section>

              {locales.length > 1 && (
                <section>
                  <h3 className="shell__sheet-label">Language</h3>
                  <div className="shell__seg">
                    {locales.map((code) => (
                      <button
                        key={code}
                        type="button"
                        aria-pressed={code === lang ? 'true' : 'false'}
                        onClick={() => setLang(code)}
                      >
                        {code.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {/* The bar's Canvas button, spelled out. A sheet has room to name
                  both destinations, and on a phone this is the only route
                  between them. */}
              <section>
                <h3 className="shell__sheet-label">View</h3>
                <div className="shell__seg">
                  <button type="button" aria-pressed={view === 'canvas' ? 'true' : 'false'} onClick={() => onView('canvas')}>Canvas</button>
                  <button
                    type="button"
                    aria-pressed={view === 'flow' ? 'true' : 'false'}
                    disabled={!screen && !fallbackPageId}
                    onClick={() => {
                      if (!screen && fallbackPageId) onPage(fallbackPageId)
                      onView('flow')
                    }}
                  >
                    Flow
                  </button>
                </div>
              </section>

              {SCREENS.length > 0 && (
                <section>
                  <h3 className="shell__sheet-label">Screens</h3>
                  <div className="shell__sheet-list">
                    {SCREENS.map((entry) => (
                      <button
                        key={entry.key}
                        type="button"
                        aria-current={entry.key === pageId ? 'true' : undefined}
                        onClick={() => {
                          onPage(entry.key)
                          onView('flow')
                          setSheetOpen(false)
                        }}
                      >
                        <span className="shell__radio" />
                        {entry.label}
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {BOARDS.length > 1 && (
                <section>
                  <h3 className="shell__sheet-label">Boards</h3>
                  <div className="shell__sheet-list">
                    {BOARDS.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        aria-current={entry.id === boardId ? 'true' : undefined}
                        onClick={() => { onBoard(entry.id) }}
                      >
                        <span className="shell__radio" />
                        {entry.name}
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </div>
          </div>
        </div>
      )}
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
`

/**
 * Every file the shell writes once. Ordered so a reader meets the entry point
 * before the parts it pulls in.
 */
export function staticShellFiles(): ShellFile[] {
  return [
    { relPath: 'index.html', contents: INDEX_HTML },
    { relPath: 'vite.config.js', contents: VITE_CONFIG },
    { relPath: `${PROTOTYPE_SHELL_DIR}/main.jsx`, contents: MAIN_JSX },
    { relPath: `${PROTOTYPE_SHELL_DIR}/App.jsx`, contents: APP_JSX },
    screenFrameFile(),
    ...canvasShellFiles(),
    { relPath: `${PROTOTYPE_SHELL_DIR}/shell.css`, contents: SHELL_CSS },
    { relPath: `${PROTOTYPE_SHELL_DIR}/urlState.js`, contents: URL_STATE_JS },
  ]
}
