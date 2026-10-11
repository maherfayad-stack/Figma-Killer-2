/**
 * projectTextDefaults - what a text the Text tool creates OUTSIDE any page
 * looks like, taken from the project it belongs to.
 *
 * A text drawn inside a frame inherits the page's body typography on its own.
 * A loose layer on the free canvas renders in a document of its own that
 * inherits nothing, so it came out as the browser's default - black Times on a
 * dark board - and looked like a bug in the tool. The layer is written with the
 * project's own body typography instead: the family, size, weight and line
 * height a text in the project's screens has, and its text colour.
 *
 * Read from a mounted portal frame's `<body>` (computed, so a stylesheet or a
 * token resolves to what the user sees). With no frame mounted there is no
 * project typography to read and the layer keeps the module's own default.
 */
import { listFrameAdapters } from './frameAdapter/canvasFrameAdapterRegistry'
import { isPortalFrameAdapter } from './frameAdapter/PortalFrameAdapter'

/** Inline-style keys (React spelling) a loose text is written with. */
export function projectBodyTextStyles(): Record<string, string> {
  for (const adapter of listFrameAdapters().values()) {
    if (!isPortalFrameAdapter(adapter)) continue
    const view = adapter.getPortalWindow()
    const body = view?.document.body
    if (!view || !body) continue
    const computed = view.getComputedStyle(body)
    const styles: Record<string, string> = {}
    if (computed.fontFamily) styles.fontFamily = computed.fontFamily
    if (computed.fontSize) styles.fontSize = computed.fontSize
    if (computed.fontWeight) styles.fontWeight = computed.fontWeight
    // `normal` is the browser's own default, not a project decision.
    if (computed.lineHeight && computed.lineHeight !== 'normal') styles.lineHeight = computed.lineHeight
    if (computed.color) styles.color = computed.color
    return styles
  }
  return {}
}
