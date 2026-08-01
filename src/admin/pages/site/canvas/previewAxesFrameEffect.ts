/**
 * previewAxesFrameEffect — WS-10 Phase 1: applies the board's preview axes to
 * an already-mounted frame document's `<html>`. Pure DOM mutation, no React
 * state — `IframeFrameSurface.tsx` calls this from a plain `useEffect` keyed
 * on the axes + capability, never through `srcDoc` or a `key` (risk §7.1: a
 * frame remount here would cost ~100-140ms per frame — see `perf-01` in
 * `STATE.md` — for every toggle across the whole board).
 */
import { useEffect, useSyncExternalStore } from 'react'
import { useEditorStore } from '@site/store/store'
import type { PreviewAxes } from '@core/studio-board'
import {
  getColorSchemeCapability,
  subscribeColorSchemeCapability,
  type ColorSchemeCapability,
} from '@site/studio/previewAxesCapability'
import { DARK_SCHEME_ATTR } from './darkSchemeCssTransform'

/**
 * A generic RTL-representative language for Phase 1's `lang` companion to
 * `dir` — Studio has no real per-project locale yet (that's WS-10 Phase 2,
 * §1's "locale is parse-time"). Arabic is the conventional stand-in a
 * direction-only RTL preview reaches for (same choice DevTools-adjacent RTL
 * emulation tools make) so language-sensitive UA behaviour (bidi-aware form
 * controls, `:lang()` rules a project's own CSS may declare) matches the
 * direction being previewed, without Studio fabricating a specific locale it
 * does not actually know. Replaced by the real per-project locale in Phase 2.
 */
const RTL_PREVIEW_LANG = 'ar'

type ClassSelector = { kind: 'class'; name: string }
type AttributeSelector = { kind: 'attribute'; name: string; value: string | null }

/**
 * Parses the `selector` a `'class'`-mechanism `ColorSchemeCapability` probe
 * detected — either `.dark` (a class name) or `[data-theme="dark"]` (an
 * attribute + value). Returns `null` for anything else so a probe result the
 * canvas doesn't know how to apply degrades to "do nothing" rather than
 * guessing.
 */
export function parseClassSchemeSelector(selector: string): ClassSelector | AttributeSelector | null {
  const classMatch = /^\.([\w-]+)$/.exec(selector)
  if (classMatch) return { kind: 'class', name: classMatch[1]! }

  const attrMatch = /^\[([\w-]+)(?:\s*=\s*["']?([\w-]*)["']?)?\]$/.exec(selector)
  if (attrMatch) return { kind: 'attribute', name: attrMatch[1]!, value: attrMatch[2] ?? null }

  return null
}

/**
 * Applies `axes` to `html` — the frame document's root element. Always:
 *   - `dir` — the load-bearing mechanism (Trap #1: no wrapper element, the
 *     attribute goes on the document element the frame already has).
 *   - `lang` — see {@link RTL_PREVIEW_LANG}'s doc.
 *   - `data-studio-scheme` + inline `color-scheme` — the generic attribute
 *     `darkSchemeCssTransform.ts`'s rewritten rules match against, and the UA
 *     hint so native form controls / scrollbars follow the preview instead of
 *     staying light in a dark frame. Set unconditionally, regardless of the
 *     detected mechanism — harmless when nothing in the document's CSS
 *     matches it.
 *
 * Additionally, when `capability.mechanism === 'class'` and its `selector`
 * parses, toggles that EXACT class/attribute on `html` too — the project's
 * own dark-mode gate, so its styles respond exactly as they would in the
 * real app rather than relying solely on the generic attribute above.
 */
export function applyPreviewAxesToFrameDocument(
  html: HTMLElement,
  axes: PreviewAxes,
  capability: ColorSchemeCapability | null,
): void {
  html.setAttribute('dir', axes.direction)
  if (axes.direction === 'rtl') html.setAttribute('lang', RTL_PREVIEW_LANG)
  else html.removeAttribute('lang')

  html.setAttribute(DARK_SCHEME_ATTR, axes.colorScheme)
  html.style.colorScheme = axes.colorScheme

  if (capability?.mechanism !== 'class' || !capability.selector) return
  const parsed = parseClassSchemeSelector(capability.selector)
  if (!parsed) return

  const isDark = axes.colorScheme === 'dark'
  if (parsed.kind === 'class') {
    html.classList.toggle(parsed.name, isDark)
    return
  }
  if (isDark) html.setAttribute(parsed.name, parsed.value ?? '')
  else html.removeAttribute(parsed.name)
}

/**
 * `IframeFrameSurface.tsx`'s one call site for the whole mechanism: reads
 * `previewAxes` from the store + the color-scheme capability from its
 * external store (`previewAxesCapability.ts` — per-project, refreshed on
 * project open, so every frame reads the SAME probe result without prop
 * drilling), and applies them via `applyPreviewAxesToFrameDocument` in a
 * plain `useEffect` keyed on the frame document + both inputs. See this
 * module's top doc for why that has to be an attribute effect, never
 * `srcDoc`/a `key`.
 */
export function useApplyPreviewAxes(iframeDoc: Document | null): void {
  const previewAxes = useEditorStore((s) => s.previewAxes)
  const colorSchemeCapability = useSyncExternalStore(
    subscribeColorSchemeCapability,
    getColorSchemeCapability,
    getColorSchemeCapability,
  )

  useEffect(() => {
    if (!iframeDoc?.documentElement) return
    applyPreviewAxesToFrameDocument(iframeDoc.documentElement, previewAxes, colorSchemeCapability)
  }, [iframeDoc, previewAxes, colorSchemeCapability])
}
