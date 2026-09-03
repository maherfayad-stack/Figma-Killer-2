import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { applyColorSchemeGate } from './registry.generated'
import { linkForClick } from './Player'

/**
 * Enough to stop the iframe's own document adding a body margin, and to take
 * the scrollbars off every scroll container inside the screen. A real phone
 * draws no persistent scrollbar; one down the side of a preview is both a lie
 * about the design and a theft of ~15px of its width. Scrolling still works —
 * this hides the indicator, not the overflow.
 */
const RESET =
  'html,body{margin:0;padding:0;height:100%;}' +
  '*{scrollbar-width:none;}*::-webkit-scrollbar{width:0;height:0;}'

/**
 * Mirror every stylesheet in the top document into 'doc', and keep mirroring
 * as more arrive.
 *
 * Vite injects a <style> per CSS module as its JS module loads, which is
 * usually AFTER this iframe has mounted, and rewrites the text of those same
 * nodes on hot reload. So this both adopts new nodes and re-copies the text of
 * ones already adopted. Returns a teardown.
 */
function mirrorStyles(doc) {
  const clones = new Map()

  function sync() {
    const sources = document.querySelectorAll('style, link[rel="stylesheet"]')
    for (const source of sources) {
      const existing = clones.get(source)
      if (existing) {
        // HMR rewrites a <style> in place rather than replacing the node.
        if (source.tagName === 'STYLE' && existing.textContent !== source.textContent) {
          existing.textContent = source.textContent
        }
        continue
      }
      const clone = source.cloneNode(true)
      doc.head.appendChild(clone)
      clones.set(source, clone)
    }
  }

  sync()
  const observer = new MutationObserver(sync)
  observer.observe(document.head, { childList: true, subtree: true, characterData: true })
  return () => observer.disconnect()
}

/**
 * A device-sized viewport with one screen inside it.
 *
 * 'width'/'height' are the DEVICE's size — pass the board frame's own width and
 * height on the canvas, or '100%' to fill a container (the flow view, where the
 * bezel decides the size). Whatever they are, the content inside sees them as
 * the viewport, which is the entire point.
 */
export default function ScreenFrame({ width, height, dir, lang, theme, title, links, onFollow, children }) {
  const ref = useRef(null)
  const [doc, setDoc] = useState(null)

  // The document of a src-less iframe is ready synchronously, but it is
  // replaced on the load event in some browsers — so take it both times and
  // let the second win.
  useEffect(() => {
    const iframe = ref.current
    if (!iframe) return undefined
    const adopt = () => setDoc(iframe.contentDocument || null)
    adopt()
    iframe.addEventListener('load', adopt)
    return () => iframe.removeEventListener('load', adopt)
  }, [])

  useEffect(() => {
    if (!doc || !doc.head) return undefined
    const reset = doc.createElement('style')
    reset.textContent = RESET
    doc.head.appendChild(reset)
    return mirrorStyles(doc)
  }, [doc])

  // On the iframe's OWN <html> — the parent document's attributes do not cross
  // the boundary, and these are what the project's CSS gates on.
  useEffect(() => {
    if (!doc || !doc.documentElement) return
    const html = doc.documentElement
    if (dir) html.setAttribute('dir', dir)
    if (lang) html.setAttribute('lang', lang)
    if (theme) {
      html.setAttribute('data-theme', theme)
      html.style.colorScheme = theme
      applyColorSchemeGate(html, theme)
    }
  }, [doc, dir, lang, theme])

  // Prototype links, delegated on the frame's own document. Capture phase so a
  // link fires before the screen's own handlers — a linked button is a
  // prototype target first and a button second.
  useEffect(() => {
    if (!doc || !links || links.length === 0 || !onFollow) return undefined
    const onClick = (event) => {
      const link = linkForClick(doc, links, event.target)
      if (!link) return
      event.preventDefault()
      event.stopPropagation()
      onFollow(link)
    }
    doc.addEventListener('click', onClick, true)
    return () => doc.removeEventListener('click', onClick, true)
  }, [doc, links, onFollow])

  return (
    <iframe
      ref={ref}
      title={title || 'Screen preview'}
      style={{ display: 'block', width: width, height: height, border: 0, colorScheme: theme || 'normal' }}
    >
      {doc && doc.body ? createPortal(children, doc.body) : null}
    </iframe>
  )
}
