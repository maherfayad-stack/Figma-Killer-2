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

const SHELL_CSS = `/* The shell's own chrome. Everything inside a frame is the project's CSS —
   these tokens never leak in, and none of them are design-system tokens. */
:root {
  --shell-board: #f7f9fa;
  --shell-surface: #ffffff;
  /* The tinted surface: option rows and control fills, so a stack of bars
     reads as one primary row and N qualifiers rather than N equal bars. */
  --shell-surface-2: #f7f9fa;
  --shell-text: #1c1c1c;
  --shell-text-subtle: #66797f;
  --shell-hover: rgba(0, 0, 0, 0.06);
  --shell-accent: #0c9ab0;
  /* ONE hairline colour, for every rule the chrome draws and for the ring
     around a device. They are the same line at two scales, so they are one
     token — a second token holding the same value is how they drift apart. */
  --shell-line: #d8dcde;
  /* The live-option marker. The only warm colour in the shell, and it earns
     its place by marking exactly one thing: which option in a row is on. */
  --shell-marker: #ef4550;
  /* The canvas dot grid, and the device bezel each frame is set into. */
  --shell-dot: rgba(0, 0, 0, 0.16);
  --shell-bezel: #ffffff;
  /* The sheet's grab handle, and the track a segmented control sits in. */
  --shell-grabber: #edf1f3;
}

html[data-theme='dark'] {
  --shell-board: #232525;
  --shell-surface: #1c1c1c;
  --shell-surface-2: #232525;
  --shell-text: #f8f9f9;
  --shell-text-subtle: #929fa3;
  --shell-hover: rgba(255, 255, 255, 0.08);
  --shell-line: #3c4244;
  --shell-dot: rgba(255, 255, 255, 0.12);
  /* Not white in the dark: a white bezel around a dark screen is a lightbox. */
  --shell-bezel: #1c1c1c;
  --shell-grabber: #3c4244;
}

* { box-sizing: border-box; }

/* No scrollbars anywhere the shell draws. A phone has no persistent
   scrollbar, so one running down the side of a preview both lies about the
   design and steals width from it. Scrolling itself is untouched — this hides
   the indicator, not the overflow. Stated once, on *, so a scroll container
   added later cannot reintroduce one. */
* { scrollbar-width: none; }
*::-webkit-scrollbar { width: 0; height: 0; }

html, body, #root { height: 100%; margin: 0; }

body {
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: var(--shell-text);
  background: var(--shell-board);
  overscroll-behavior: none;
}

.shell { display: flex; flex-direction: column; height: 100%; }

/* The bar and every option row move as ONE block. That is what lets the mobile
   rule be a single position:fixed instead of a chain of sibling selectors that
   has to be re-derived every time a row is added. */
.shell__chrome { flex-shrink: 0; }

.shell__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 52px;
  padding: 0 20px;
  background: var(--shell-surface);
  border-bottom: 1px solid var(--shell-line);
}

/* The project's name. The last word takes the accent — the one decorative use
   of colour in the shell, and it is a single word in a corner. */
.shell__title { font-size: 14px; font-weight: 600; color: var(--shell-text); white-space: nowrap; }
.shell__title em { font-style: normal; color: var(--shell-accent); }

.shell__spacer { flex: 1; }

.shell__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--shell-line);
  border-radius: 8px;
  background: var(--shell-surface-2);
  color: var(--shell-text);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
}

.shell__btn:hover { border-color: var(--shell-text-subtle); }

/* Outlined, not filled. A filled button reads as the primary ACTION on the
   bar; this is reporting which view you are in. */
.shell__btn[aria-pressed='true'] { border-color: var(--shell-accent); color: var(--shell-accent); }

.shell__btn--icon { padding: 0 8px; }
.shell__btn svg { display: block; }
.shell__btn:focus-visible { outline: 2px solid var(--shell-accent); outline-offset: 1px; }

/* A row of options: text links, with a marker under the live one. Buttons
   stretch the row's full height so that marker lands on the row's own edge
   rather than floating inside it. */
.shell__nav {
  display: flex;
  align-items: stretch;
  gap: 8px;
  height: 40px;
  padding: 0 20px;
  overflow-x: auto;
  background: var(--shell-surface);
  border-bottom: 1px solid var(--shell-line);
}

/* A row that picks a VARIANT of what you are looking at, rather than what you
   are looking at, sits on the tinted surface. */
.shell__nav--group { background: var(--shell-surface-2); }

.shell__nav-label {
  display: flex;
  align-items: center;
  padding-right: 8px;
  border-right: 1px solid var(--shell-line);
  font-size: 13px;
  font-weight: 600;
  color: var(--shell-text);
  white-space: nowrap;
}

.shell__nav button {
  padding: 0 4px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--shell-text-subtle);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
}

.shell__nav button:hover { color: var(--shell-text); }

.shell__nav button[aria-current='true'] {
  border-bottom-color: var(--shell-marker);
  color: var(--shell-accent);
  font-weight: 600;
}

.shell__nav button:focus-visible { outline: 2px solid var(--shell-accent); outline-offset: -2px; }

/* Flow view — one device, centred, scrollable when the window is short. */
.shell__stage {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  overflow-y: auto;
  padding: clamp(8px, 4vh, 40px) 0;
  background: var(--shell-board);
}

/* NOT transform: scale() — a transformed ancestor kills backdrop-filter, and
   these screens are mostly glass. */
.shell__phone {
  position: relative;
  flex-shrink: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  /* Set from JS as custom properties rather than inline width/height, so the
     mobile rules below can take the device full-bleed without !important. */
  width: var(--device-w);
  height: min(var(--device-h), 100%);
  border-radius: 50px;
  background: var(--background-base-default);
  box-shadow: 0 0 0 1px var(--shell-line), 0 20px 60px rgba(0, 0, 0, 0.32);
}

.shell__empty {
  margin: auto;
  max-width: 32rem;
  padding: 24px;
  text-align: center;
  color: var(--shell-text-subtle);
  line-height: 1.5;
}

/* On a phone the browser IS the device, so the shell's own chrome is in the
   way: it squeezed the screen between two bars, clipped the design, and the
   toolbar itself overflowed a 390px window. There, the bar is replaced by one
   floating control and a sheet — the screen keeps the whole viewport, which is
   the only way a phone design previews honestly on a phone. */
.shell__gear {
  display: none;
  position: fixed;
  z-index: 30;
  top: 12px;
  right: 12px;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 0;
  border-radius: 100px;
  background: var(--shell-surface);
  color: var(--shell-text);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  cursor: pointer;
}

.shell__gear svg { display: block; }

.shell__sheet { position: fixed; inset: 0; z-index: 40; display: flex; align-items: flex-end; }

/* Blurred, not just dimmed: the sheet is over the design, and a sharp design
   behind a translucent panel reads as two things at one depth. */
.shell__sheet-scrim {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(20px);
  border: 0;
  padding: 0;
}

.shell__sheet-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: calc(100% - 12px);
  max-height: 82%;
  margin: 0 6px 6px;
  border-radius: 34px;
  background: var(--shell-surface);
  box-shadow: inset 0 0.5px 0 rgba(255, 255, 255, 0.9), 0 -8px 40px rgba(0, 0, 0, 0.18);
  animation: shell-sheet-in 280ms cubic-bezier(0.32, 0.72, 0, 1);
}

@keyframes shell-sheet-in {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}

.shell__sheet-grabber {
  width: 36px;
  height: 5px;
  margin: 8px auto 0;
  border-radius: 100px;
  background: var(--shell-grabber);
}

.shell__sheet-head {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 4px 56px;
}

.shell__sheet-title { margin: 0; font-size: 14px; font-weight: 600; color: var(--shell-text); }
.shell__sheet-sub { margin: 0; font-size: 12px; color: var(--shell-text-subtle); }

.shell__sheet-close {
  position: absolute;
  top: 50%;
  inset-inline-start: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  transform: translateY(-50%);
  border: 0;
  border-radius: 100px;
  background: var(--shell-surface-2);
  color: var(--shell-text);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.shell__sheet-body { padding: 12px 16px 24px; overflow-y: auto; }
.shell__sheet-body section + section { margin-top: 20px; }

.shell__sheet-label {
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--shell-text-subtle);
}

/* A pill track with the live option lifted out of it in the surface colour —
   the same shape iOS uses, because that is what the sheet is imitating. */
.shell__seg { display: flex; gap: 4px; padding: 3px; border-radius: 100px; background: var(--shell-grabber); }

.shell__seg button {
  flex: 1;
  height: 28px;
  border: 0;
  border-radius: 100px;
  background: transparent;
  color: var(--shell-text);
  font: inherit;
  font-size: 14px;
  cursor: pointer;
}

.shell__seg button[aria-pressed='true'] {
  background: var(--shell-surface);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}

.shell__sheet-list { display: flex; flex-direction: column; }

.shell__sheet-list button {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--shell-text);
  font: inherit;
  font-size: 14px;
  text-align: start;
  cursor: pointer;
}

.shell__sheet-list button[aria-current='true'] { font-weight: 600; }

.shell__radio {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border: 1.5px solid var(--shell-line);
  border-radius: 100px;
}

/* Filled by thickening its own border, so the dot needs no second element. */
.shell__sheet-list button[aria-current='true'] .shell__radio {
  border-width: 5px;
  border-color: var(--shell-accent);
}

.shell__gear:focus-visible,
.shell__sheet-close:focus-visible,
.shell__seg button:focus-visible,
.shell__sheet-list button:focus-visible { outline: 2px solid var(--shell-accent); outline-offset: 2px; }

@media (prefers-reduced-motion: reduce) {
  .shell__sheet-panel { animation: none; }
}

@media (max-width: 700px) {
  .shell__gear { display: flex; }

  /* The bar and its rows do not shrink to fit here — they are replaced. */
  .shell__chrome { display: none; }

  .shell__stage { padding: 0; }

  .shell__phone {
    width: 100%;
    height: 100%;
    border-radius: 0;
    box-shadow: none;
  }
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
