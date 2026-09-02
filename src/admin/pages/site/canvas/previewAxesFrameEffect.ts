/**
 * previewAxesFrameEffect — WS-10 Phase 1: applies the board's preview axes to
 * an already-mounted frame document's `<html>`. Pure DOM mutation, no React
 * state — `IframeFrameSurface.tsx` calls this from a plain `useEffect` keyed
 * on the axes + capability, never through `srcDoc` or a `key` (risk §7.1: a
 * frame remount here would cost ~100-140ms per frame — see `perf-01` in
 * `STATE.md` — for every toggle across the whole board).
 */
import { createContext, useContext, useEffect, useSyncExternalStore } from 'react'
import { useEditorStore } from '@site/store/store'
import { DEFAULT_PREVIEW_AXES, type PreviewAxes } from '@core/studio-board'
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
 * The de-facto convention every design system shipped as vendor CSS uses to
 * gate its token set, and therefore the one attribute the frame root must
 * carry an EXPLICIT value for in BOTH schemes.
 *
 * Absence is not neutral. `@alm-design/design-system` — which
 * `ProjectCssInjector.tsx` injects into every canvas frame — gates its light
 * tokens on `:root:not([data-theme=light])`, i.e. **no attribute means
 * dark**. So the previous behaviour here (set `data-theme="dark"` for dark,
 * REMOVE it for light) previewed light as dark: exactly the same
 * "broken in both directions" shape as the `prefers-color-scheme` bug
 * `darkSchemeCssTransform.ts` exists to fix, one layer up. Writing
 * `light`/`dark` explicitly is correct for both conventions — a project that
 * only styles `[data-theme=dark]` simply doesn't match `light`.
 *
 * Set unconditionally, whatever mechanism the probe detected, because the
 * vendor CSS is injected unconditionally too. When the detected mechanism IS
 * this attribute, the two writes agree by construction.
 */
export const VENDOR_THEME_ATTR = 'data-theme'

/**
 * Applies `axes` to `html` — the frame document's root element. Always:
 *   - `dir` — the load-bearing mechanism (Trap #1: no wrapper element, the
 *     attribute goes on the document element the frame already has). Note
 *     this drives CSS only; a design-system component that resolves its
 *     direction in JS (a `useDir()`/provider context) is driven separately,
 *     through {@link FramePreviewAxesContext}.
 *   - `lang` — see {@link RTL_PREVIEW_LANG}'s doc.
 *   - `data-studio-scheme` + inline `color-scheme` — the generic attribute
 *     `darkSchemeCssTransform.ts`'s rewritten rules match against, and the UA
 *     hint so native form controls / scrollbars follow the preview instead of
 *     staying light in a dark frame. Set unconditionally, regardless of the
 *     detected mechanism — harmless when nothing in the document's CSS
 *     matches it.
 *   - `data-theme` — see {@link VENDOR_THEME_ATTR}.
 *
 * Additionally, when `capability.mechanism === 'class'` and its `selector`
 * parses, toggles that EXACT class/attribute on `html` too — the project's
 * own dark-mode gate, so its styles respond exactly as they would in the
 * real app rather than relying solely on the generic attributes above.
 */
export function applyPreviewAxesToFrameDocument(
  html: HTMLElement,
  axes: PreviewAxes,
  capability: ColorSchemeCapability | null,
): void {
  html.setAttribute('dir', axes.direction)
  if (axes.direction === 'rtl') html.setAttribute('lang', RTL_PREVIEW_LANG)
  else html.removeAttribute('lang')

  const isDark = axes.colorScheme === 'dark'
  html.setAttribute(DARK_SCHEME_ATTR, axes.colorScheme)
  html.setAttribute(VENDOR_THEME_ATTR, axes.colorScheme)
  html.style.colorScheme = axes.colorScheme

  if (capability?.mechanism !== 'class' || !capability.selector) return
  const parsed = parseClassSchemeSelector(capability.selector)
  if (!parsed) return

  if (parsed.kind === 'class') {
    // A class gate has no light counterpart to add — `.dark` off IS light.
    html.classList.toggle(parsed.name, isDark)
    return
  }
  // An attribute gate does: see `VENDOR_THEME_ATTR` for why removing it is
  // not the same as saying "light".
  html.setAttribute(parsed.name, isDark ? (parsed.value ?? 'dark') : 'light')
}

/**
 * WS-10 Phase 2 (§4.4) — a "duplicate as variant" board frame's own
 * `BoardFrame.axes` overrides the board-global default PER AXIS, not
 * wholesale: a frame that only overrides `direction` still inherits the
 * board's current `colorScheme`.
 */
function resolveFrameAxes(boardAxes: PreviewAxes, override: Partial<PreviewAxes> | undefined): PreviewAxes {
  return override ? { ...boardAxes, ...override } : boardAxes
}

/**
 * The axes THIS frame is being previewed under, published to everything
 * React renders inside it.
 *
 * `dir` on the frame's `<html>` is enough for CSS, and it is NOT enough for
 * a design system whose components resolve their own direction in JavaScript.
 * `@alm-design/design-system` is the case that forced this: every component
 * calls `useDir(prop)`, which reads `DesignSystemProvider`'s context and
 * falls back to a built-in `'ltr'`. Studio wraps each design-system component
 * in that provider (`src/modules/alm/register.tsx`,
 * `registerProjectModules.ts`) and used to pass it NO props at all — so every
 * mirrored chevron, every direction-aware label and every platform-aware
 * layout on the canvas was pinned left-to-right no matter what the board's
 * direction toggle said, while the CSS half of the same component flipped.
 * Half-RTL screens, which is worse than either whole.
 *
 * A context (rather than reading `document.dir` back off the frame) because
 * per-frame overrides are real — a "duplicate as variant" frame previews RTL
 * beside the board's LTR — so "the direction" is a property of the frame a
 * component is rendered into, not of the board.
 *
 * The default value is the board default, for the one case where a module
 * component renders outside any frame (a panel preview): LTR/light, which is
 * what it rendered as before this existed.
 */
export const FramePreviewAxesContext = createContext<PreviewAxes>(DEFAULT_PREVIEW_AXES)

/** The preview axes of the frame the calling component is rendered into. See {@link FramePreviewAxesContext}. */
export function useFramePreviewAxes(): PreviewAxes {
  return useContext(FramePreviewAxesContext)
}

/**
 * The same merge {@link useApplyPreviewAxes} performs, for a component that is
 * OUTSIDE the frame's portal and so cannot read
 * {@link FramePreviewAxesContext} — `BreakpointFrame`'s wrapper element, which
 * paints the same paper the iframe does.
 */
export function useResolvedFrameAxes(axesOverride?: Partial<PreviewAxes>): PreviewAxes {
  const boardAxes = useEditorStore((s) => s.previewAxes)
  return resolveFrameAxes(boardAxes, axesOverride)
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
 *
 * Returns the frame's EFFECTIVE axes so the caller can publish them on
 * {@link FramePreviewAxesContext} — one resolution of the board/override
 * merge, feeding both the DOM attributes and the React tree.
 */
export function useApplyPreviewAxes(
  iframeDoc: Document | null,
  axesOverride?: Partial<PreviewAxes>,
): PreviewAxes {
  const boardAxes = useEditorStore((s) => s.previewAxes)
  const colorSchemeCapability = useSyncExternalStore(
    subscribeColorSchemeCapability,
    getColorSchemeCapability,
    getColorSchemeCapability,
  )
  const effectiveAxes = resolveFrameAxes(boardAxes, axesOverride)
  useEffect(() => {
    if (!iframeDoc?.documentElement) return
    // Re-resolved inside the effect rather than closing over `effectiveAxes`
    // so the dependency array names the two ACTUAL inputs. Depending on the
    // merged object instead makes `react-hooks/exhaustive-deps` warn about a
    // conditionally-constructed value it cannot prove stable — and the fix it
    // asks for (`useMemo`) is exactly the manual memoization this repo's
    // React Compiler setup bans.
    applyPreviewAxesToFrameDocument(
      iframeDoc.documentElement,
      resolveFrameAxes(boardAxes, axesOverride),
      colorSchemeCapability,
    )
  }, [iframeDoc, boardAxes, axesOverride, colorSchemeCapability])
  return effectiveAxes
}
