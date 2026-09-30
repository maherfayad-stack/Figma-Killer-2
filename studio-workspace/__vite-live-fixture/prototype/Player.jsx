import { useCallback, useMemo, useState } from 'react'
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
