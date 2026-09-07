/**
 * playerTemplate — `Player.jsx`: the flow view that actually plays the
 * interactions authored on the Studio board.
 *
 * ## The problem this solves
 *
 * A link is authored in Studio against a node id (`pages/SignUp.tsx:30:16`),
 * and the exported app has no node ids: it is plain React rendering plain DOM,
 * with none of the `data-node-id` attributes Studio injects into its canvas
 * iframes. So the id a link was drawn against cannot be looked up here.
 *
 * What CAN be looked up is the other half of the anchor. Every link carries an
 * `indexPath` — the child-index path from the page root, e.g. `[0, 1, 1, 0, 1,
 * 0]` — and that resolves against ordinary rendered DOM by walking
 * `element.children`. Verified against the real export: the path above lands
 * exactly on the Continue button its link was authored on.
 *
 * It resolves because Studio's tree and the DOM agree on shape for the nodes a
 * link can be drawn on — one element per node, in source order. Where they
 * disagree (a component rendering a fragment or several roots) the walk simply
 * finds nothing, and the link is inert rather than wrong. That is the right
 * failure: a link that silently fired on the wrong element would be worse than
 * one that does nothing.
 *
 * ## The playback model
 *
 * Mirrors `@core/studio-prototype`'s `applyPlayAction`, which the editor's own
 * preview uses — deliberately the same four actions and the same stack
 * semantics, so a prototype behaves the same in Studio and in the export:
 *
 *   - `navigate` replaces the screen and pushes onto the history stack
 *   - `overlay` presents on top; the screen underneath stays mounted
 *   - `back` pops the stack, reversing whatever brought you here
 *   - `close` dismisses the top overlay
 *
 * It is re-implemented rather than imported because the export is a standalone
 * app with no dependency on this repository — the same reason the registry is
 * generated rather than read from `.studio/` at runtime.
 */
import { PROTOTYPE_SHELL_DIR, type ShellFile } from './shellPaths'

/** Same no-backticks rule as every template here: this is a template literal. */
const PLAYER_JSX = `import { useCallback, useMemo, useState } from 'react'
import ScreenFrame from './ScreenFrame'
import { LINKS, SCREENS } from './registry.generated'
import './Player.css'

const SCREEN_BY_ID = Object.fromEntries(SCREENS.map((screen) => [screen.key, screen]))


/**
 * The element a link was drawn on, by walking child indexes from the page root.
 *
 * Returns null the moment the path leaves the tree — a screen edited since the
 * link was authored simply has an inert link rather than one that fires on
 * whatever now happens to sit at that index.
 */
export function resolveLinkElement(doc, link) {
  const path = link && link.source && link.source.node ? link.source.node.indexPath : null
  if (!doc || !doc.body || !Array.isArray(path)) return null
  let el = doc.body
  for (const index of path) {
    if (!el || !el.children || !el.children[index]) return null
    el = el.children[index]
  }
  return el
}

/**
 * The innermost link under a click, or null.
 *
 * Innermost wins, which is the only rule that behaves the way anyone expects
 * when a linked button sits inside a linked card: you followed the thing you
 * actually clicked.
 */
export function linkForClick(doc, links, target) {
  for (let el = target; el && el !== doc.body; el = el.parentElement) {
    const match = links.find((link) => resolveLinkElement(doc, link) === el)
    if (match) return match
  }
  return null
}

/** One screen, playing its own links. */
function PlayScreen({ pageId, links, dir, lang, theme, onFollow, className }) {
  const screen = SCREEN_BY_ID[pageId]
  const onPage = useMemo(
    () => links.filter((link) => link.source && link.source.pageId === pageId),
    [links, pageId],
  )
  if (!screen) return null
  return (
    <ScreenFrame
      width="100%"
      height="100%"
      dir={dir}
      lang={lang}
      theme={theme}
      title={screen.label}
      links={onPage}
      onFollow={onFollow}
      className={className}
    >
      <screen.Component />
    </ScreenFrame>
  )
}

/**
 * The flow view: one screen at device size, plus whatever is presented over it.
 *
 * 'pageId' is the screen the surrounding shell selected; following a link
 * changes what is shown here and reports the new screen back through
 * 'onPageChange' so the tab strip and the URL stay honest.
 */
export default function Player({ pageId, onPageChange, dir, lang, theme }) {
  // The base screen, plus the screens a 'navigate' came from — 'back' pops it.
  const [history, setHistory] = useState([])
  const [overlay, setOverlay] = useState(null)

  const follow = useCallback(
    (link) => {
      const action = link.action
      if (action === 'navigate' && link.targetPageId) {
        setOverlay(null)
        setHistory((stack) => [...stack, pageId])
        onPageChange(link.targetPageId)
        return
      }
      if (action === 'overlay' && link.targetPageId) {
        setOverlay({ pageId: link.targetPageId, transition: link.transition || 'sheet' })
        return
      }
      if (action === 'close') {
        setOverlay(null)
        return
      }
      if (action === 'back') {
        // An overlay is on top of the screen, so Back dismisses that first —
        // the same order a real app's back gesture would.
        if (overlay) { setOverlay(null); return }
        setHistory((stack) => {
          const previous = stack[stack.length - 1]
          if (previous === undefined) return stack
          onPageChange(previous)
          return stack.slice(0, -1)
        })
      }
    },
    [overlay, pageId, onPageChange],
  )

  const overlayClass = overlay ? 'play-enter play-enter--' + overlay.transition : ''

  return (
    <div className="play">
      <PlayScreen pageId={pageId} links={LINKS} dir={dir} lang={lang} theme={theme} onFollow={follow} />
      {overlay && (
        <div className={'play__overlay ' + overlayClass} onClick={(event) => {
          // The scrim dismisses, the sheet itself does not.
          if (event.target === event.currentTarget) setOverlay(null)
        }}>
          <div className="play__overlay-inner">
            <PlayScreen
              pageId={overlay.pageId}
              links={LINKS}
              dir={dir}
              lang={lang}
              theme={theme}
              onFollow={follow}
            />
          </div>
        </div>
      )}
    </div>
  )
}
`

const PLAYER_CSS = `.play {
  position: relative;
  width: 100%;
  height: 100%;
}

/* The overlay sits inside the device, not over the whole window — a sheet is
   presented by the screen, so it must be clipped by the same phone. */
.play__overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  background: rgba(0, 0, 0, 0.32);
}

.play__overlay-inner {
  position: relative;
  width: 100%;
  height: 100%;
}

.play-enter--sheet .play__overlay-inner,
.play-enter--sheet { animation: play-sheet 260ms cubic-bezier(0.32, 0.72, 0, 1); }
.play-enter--popup { animation: play-fade 180ms ease-out; }
.play-enter--dissolve { animation: play-fade 180ms ease-out; }
.play-enter--slide-left { animation: play-slide-left 260ms cubic-bezier(0.32, 0.72, 0, 1); }
.play-enter--slide-right { animation: play-slide-right 260ms cubic-bezier(0.32, 0.72, 0, 1); }
.play-enter--push-left { animation: play-slide-left 260ms cubic-bezier(0.32, 0.72, 0, 1); }
.play-enter--push-right { animation: play-slide-right 260ms cubic-bezier(0.32, 0.72, 0, 1); }
.play-enter--instant { animation: none; }

@keyframes play-sheet {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}

@keyframes play-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes play-slide-left {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}

@keyframes play-slide-right {
  from { transform: translateX(-100%); }
  to { transform: translateX(0); }
}

@media (prefers-reduced-motion: reduce) {
  .play__overlay, .play__overlay-inner { animation: none !important; }
}
`

/** `Player.jsx` and its stylesheet. */
export function playerShellFiles(): ShellFile[] {
  return [
    { relPath: PROTOTYPE_SHELL_DIR + '/Player.jsx', contents: PLAYER_JSX },
    { relPath: PROTOTYPE_SHELL_DIR + '/Player.css', contents: PLAYER_CSS },
  ]
}
