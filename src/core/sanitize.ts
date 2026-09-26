/**
 * Sanitise utility for richtext prop values.
 *
 * WHY THIS EXISTS
 * ---------------
 * The publisher's `escapeProps()` passes richtext props through WITHOUT HTML-escaping,
 * relying on the assumption that DOMPurify has already sanitized them at input time.
 * This module provides that sanitization.
 *
 * USAGE
 * -----
 * Call `sanitizeRichtext(value)` at EVERY write path that stores a richtext prop:
 *   - useSandboxBridge: PROP_CHANGE messages from sandboxed plugin module iframes
 *   - CMS draft hydration before store load
 *   - Phase D agent dispatcher: setProps tool calls for richtext-typed props
 *
 * Never trust that "the UI already sanitized it" — sanitize at every write path.
 *
 * CONFIGURATION
 * -------------
 * Default config allows safe formatting tags (strong, em, u, a, ul, ol, li, p, br, h1-h6)
 * and blocks all script execution. Use `sanitizeRichtext(val, STRICT_CONFIG)` to strip
 * all HTML tags and return plain text only (e.g. for meta fields, titles).
 *
 * @see Task #261 — Enforce DOMPurify at Properties Panel boundary
 * @see Contribution #368 — Security Auditor INFO finding
 * @see render.ts escapeProps() — richtext props are passed through unescaped
 */

import DOMPurify, { type Config } from 'dompurify'
import {
  SVG_CODE_ATTRIBUTE,
  SVG_PART_ATTRIBUTE,
  cssValueLoadsExternalResource,
  isSvgFragmentReference,
  svgStyleLoadsExternalResource,
  type SvgStyleChildNode,
} from '@core/vector'

type DOMPurifyHookNode = {
  tagName?: string
  nodeName?: string
  textContent?: string | null
  childNodes?: ArrayLike<SvgStyleChildNode>
  setAttribute?: (name: string, value: string) => void
  getAttribute?: (name: string) => string | null
}

/** DOMPurify's per-attribute hook event. Setting `forceKeepAttr` skips every later check on that attribute. */
type DOMPurifyAttributeHookEvent = {
  attrName: string
  attrValue: string
  keepAttr: boolean
  forceKeepAttr?: boolean
}

/** One entry of DOMPurify's `removed` log: a removed element, or an attribute removed from one. */
type DOMPurifyRemoval = { element?: { nodeName?: string; namespaceURI?: string | null }; attribute?: unknown }

export type DOMPurifyRuntime = {
  sanitize?: (value: string, config?: Config) => unknown
  addHook?: {
    (hookName: 'afterSanitizeAttributes', callback: (node: DOMPurifyHookNode) => void): void
    (hookName: 'uponSanitizeAttribute', callback: (node: DOMPurifyHookNode, event: DOMPurifyAttributeHookEvent) => void): void
    (hookName: 'uponSanitizeElement', callback: (node: DOMPurifyHookNode, event: { tagName: string }) => void): void
  }
  removed?: DOMPurifyRemoval[]
}

type DOMPurifyFactory = DOMPurifyRuntime & ((window: Window) => DOMPurifyRuntime)

const importedDOMPurify = DOMPurify as unknown as DOMPurifyFactory
let activeDOMPurify: DOMPurifyRuntime | null = null
const purifiersWithHooks = new WeakSet<object>()

/**
 * True only while `sanitizeSvg` is running. DOMPurify hooks are global to an
 * instance, so the SVG profile's `href` allowance is scoped by this flag
 * rather than by the config — richtext and board docs never see it.
 * `sanitize` is synchronous, so the flag cannot leak across calls.
 */
let sanitizingSvg = false

/**
 * The SVG elements whose `href` is a same-document reference an icon needs:
 * `<use href="#glyph">` sprites, gradient/pattern/filter inheritance
 * (`<linearGradient href="#base">`), text on a path, a motion path, and a
 * filter image of another element. Every other element keeps DOMPurify's
 * blanket `href` refusal.
 */
const SVG_FRAGMENT_HREF_ELEMENTS: ReadonlySet<string> = new Set([
  'use', 'lineargradient', 'radialgradient', 'pattern', 'filter', 'textpath', 'mpath', 'feimage',
])

/**
 * Keep `href` / `xlink:href` on an {@link SVG_FRAGMENT_HREF_ELEMENTS} element
 * when — and only when — its RAW value is a same-document fragment (`#name`).
 *
 * `forceKeepAttr` bypasses DOMPurify's own URI checks for that attribute, so
 * the predicate is deliberately narrower than a URL parser: the value must
 * match `^#[\w.-]+$` exactly as written. DOMPurify hands the hook a TRIMMED
 * value and would keep the untrimmed original, so the raw attribute is read
 * back and must equal it: a leading character `trim()` removes but a URL
 * parser keeps (`U+2028#a`) would otherwise turn a fragment into a relative
 * URL — a same-origin fetch of another document, which is exactly what
 * `<use>` must never do.
 */
function keepSvgFragmentHref(node: DOMPurifyHookNode, event: DOMPurifyAttributeHookEvent): void {
  if (!sanitizingSvg) return
  if (event.attrName !== 'href' && event.attrName !== 'xlink:href') return
  if (!SVG_FRAGMENT_HREF_ELEMENTS.has(String(node.nodeName ?? node.tagName ?? '').toLowerCase())) return
  const raw = node.getAttribute?.(event.attrName)
  if (raw !== event.attrValue || !isSvgFragmentReference(raw)) return
  event.forceKeepAttr = true
}

/**
 * The SVG profile's remote-resource rule (security review of #264, N1): the
 * same `@core/vector` predicates the importer refuses on and the same outcome
 * `sanitizeSvgBytes` gives a served file, so the canvas and publish no longer
 * render what those two paths refuse. DOMPurify does not vet CSS at all.
 *
 *   - an attribute whose value loads something from outside the document
 *     (`fill="url(https://…)"`, `style="background:url(//…)"`,
 *     `image-set(…)`) is dropped. `aria-*`/`data-*` are text, not CSS;
 *   - a `<style>` block that does (`@import`, a remote `url()`), or that has
 *     any child that is not text (a kept `<tspan>` can split `@im|port`
 *     between the sheet and `textContent`), is EMPTIED rather than removed: an svg's class rules are how most exported icons
 *     paint, and removing a node from inside a DOMPurify hook is exactly the
 *     happy-dom iterator skip `sanitizeToFixpoint` exists for.
 *
 * An `<style>` inside an inline svg is document-global in the frame, so a
 * remote `@import` there is a beacon plus CSS injection against the whole page.
 */
function dropSvgRemoteAttribute(_node: DOMPurifyHookNode, event: DOMPurifyAttributeHookEvent): void {
  if (!sanitizingSvg || event.forceKeepAttr) return
  if (event.attrName.startsWith('aria-') || event.attrName.startsWith('data-')) return
  if (cssValueLoadsExternalResource(event.attrValue)) event.keepAttr = false
}

function emptySvgRemoteStyle(node: DOMPurifyHookNode, event: { tagName: string }): void {
  if (!sanitizingSvg || event.tagName.toLowerCase() !== 'style') return
  if (svgStyleLoadsExternalResource(node.childNodes ?? [])) node.textContent = ''
}

function installHooks(purifier: DOMPurifyRuntime): DOMPurifyRuntime {
  if (!purifiersWithHooks.has(purifier) && typeof purifier.addHook === 'function') {
    purifier.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        node.setAttribute?.('target', '_blank')
        node.setAttribute?.('rel', 'noopener noreferrer')
      }
    })
    purifier.addHook('uponSanitizeAttribute', keepSvgFragmentHref)
    purifier.addHook('uponSanitizeAttribute', dropSvgRemoteAttribute)
    purifier.addHook('uponSanitizeElement', emptySvgRemoteStyle)
    purifiersWithHooks.add(purifier)
  }
  return purifier
}

const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'

/**
 * Whether the last `sanitize` call removed anything from the input itself.
 *
 * DOMPurify logs one removal on EVERY call that is not the input's: the
 * `<body>` its HTML parse wraps the input in. That entry, and only that one,
 * is exempt: an element whose `nodeName` is exactly `BODY` (an HTML element;
 * an svg-namespace `body` is `body`) in the XHTML namespace, at most once per
 * pass. Nothing is exempted by name alone. Under happy-dom an input can create
 * a real mid-tree `head`/`html`/`body` (inside `<svg>`, or `HEAD` inside
 * `<table>`), and removing one skips the next node exactly like any other
 * removal (security review of #264), so it must cost another pass.
 */
function removedFromInput(purifier: DOMPurifyRuntime): boolean {
  // A runtime without the log cannot say; assume it did, and pay a pass.
  if (!purifier.removed) return true
  let wrapperSeen = false
  for (const entry of purifier.removed) {
    if (entry.attribute !== undefined) return true
    const element = entry.element
    if (!wrapperSeen && element?.nodeName === 'BODY' && element.namespaceURI === XHTML_NAMESPACE) {
      wrapperSeen = true
      continue
    }
    return true
  }
  return false
}

/** Passes after which a still-changing result is refused rather than returned. */
const MAX_SANITIZE_PASSES = 8

/**
 * `purifier.sanitize`, repeated until a pass removes nothing.
 *
 * One pass is not always enough. Under happy-dom — the DOM the Bun server
 * gives DOMPurify (`server/richtextSanitizer.ts`), and the one the publisher's
 * `escapeProps` sanitises with — removing an element makes DOMPurify's node
 * iterator skip the node after it, so that node's attributes are never
 * checked: `<foo></foo><a href="javascript:…" onclick="…">` came back with
 * both attributes intact. A browser's iterator does not skip, which is why no
 * browser test ever saw it. A second pass over the first pass's output sees
 * the skipped node (the element that caused the skip is gone), and a pass that
 * removes nothing proves the output clean. Clean input costs one pass, since
 * nothing was removed from it.
 *
 * A result still changing after {@link MAX_SANITIZE_PASSES} is refused as
 * `''`: a sanitiser that cannot prove its output clean returns nothing.
 */
function sanitizeToFixpoint(purifier: DOMPurifyRuntime, input: string, config: Config): string {
  // `removed` is REASSIGNED by every `sanitize` call, so it is read off the
  // purifier each time, never held.
  const run = (value: string): string => String(purifier.sanitize?.(value, config) ?? '')
  let current = run(input)
  for (let pass = 1; pass < MAX_SANITIZE_PASSES; pass += 1) {
    if (!removedFromInput(purifier)) return current
    const next = run(current)
    if (next === current && !removedFromInput(purifier)) return current
    current = next
  }
  return removedFromInput(purifier) ? '' : current
}

export function configureRichtextSanitizer(purifier: DOMPurifyRuntime | null): void {
  activeDOMPurify = purifier ? installHooks(purifier) : null
}

function getDOMPurify(): DOMPurifyRuntime | null {
  const direct = activeDOMPurify ?? importedDOMPurify
  if (typeof direct.sanitize === 'function') {
    return installHooks(direct)
  }

  if (typeof window !== 'undefined' && typeof importedDOMPurify === 'function') {
    activeDOMPurify = importedDOMPurify(window)
    if (typeof activeDOMPurify.sanitize === 'function') {
      return installHooks(activeDOMPurify)
    }
  }

  return null
}

/**
 * Regex HTML strip used ONLY when no DOMPurify runtime is available (one-off
 * scripts; browser + Bun server both configure DOMPurify).
 *
 * Three stages, each looped to a fixpoint with a single literal regex — the
 * exact do-while-until-stable form CodeQL recognises as a complete sanitizer
 * (js/incomplete-multi-character-sanitization). Looping matters because removing
 * one match can reveal another: split-tag obfuscation `<scr<script>ipt>` only
 * collapses after the inner match goes. Close tags use `(?:[\s/][^>]*)?` since
 * the HTML parser ends a tag at the first `>` (js/bad-tag-filter). Each pass
 * strictly shrinks the string, so every loop terminates.
 *
 * 1. drop `<script>…</script>` blocks (removes the JS source, not just the tag)
 * 2. drop `<style>…</style>` blocks (CSS can carry `@import url(javascript:…)`)
 * 3. drop every remaining tag, incl. bare/unbalanced `<script`/`<style` openers
 */
function stripHtmlFallback(value: string): string {
  let current = value
  let previous: string
  do {
    previous = current
    current = current.replace(/<script\b[^>]*>[\s\S]*?<\/script(?:[\s/][^>]*)?>/gi, '')
  } while (current !== previous)
  do {
    previous = current
    current = current.replace(/<style\b[^>]*>[\s\S]*?<\/style(?:[\s/][^>]*)?>/gi, '')
  } while (current !== previous)
  do {
    previous = current
    current = current.replace(/<[^>]*>/g, '')
  } while (current !== previous)
  return current
}

// ---------------------------------------------------------------------------
// DOMPurify configuration profiles
// ---------------------------------------------------------------------------

/**
 * Default richtext config — allows safe HTML formatting, blocks all scripts.
 * Suitable for user-authored HTML content (headings, paragraphs, lists, links).
 */
const RICHTEXT_CONFIG: Config = {
  // Allow safe semantic/formatting tags
  ALLOWED_TAGS: [
    'p', 'br',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins',
    'a', 'ul', 'ol', 'li',
    'blockquote', 'code', 'pre',
    'span', 'div',
  ],
  // Restrict attributes to safe subset; data-* is blocked by default
  ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'id'],
  // Force all links to open in a new tab with noopener
  ADD_ATTR: ['target'],
  // Never allow data: / javascript: in href
  ALLOW_DATA_ATTR: false,
  // Prevent mXSS via HTML namespace confusion
  NAMESPACE: 'http://www.w3.org/1999/xhtml',
  // Return a string, not a DOM node
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
}

/**
 * Board doc-card config — `RICHTEXT_CONFIG` plus the attributes a WYSIWYG
 * card actually produces: `style` (inline font family, font size, colour and
 * alignment, which the doc toolbar writes and markdown has no syntax for) and
 * `align`.
 *
 * Widening `style` is NOT a widening of the publisher's profile. Note what
 * it does allow: DOMPurify does not vet CSS at all, so an allowed `style`
 * attribute keeps whatever it says, `url()` included. That cannot run script
 * in a modern browser, but it can load a remote resource. What bounds it is
 * where it renders: a `DocBlock` is board furniture — it lives in
 * `.studio/boards.json`, renders only inside the admin canvas, and is never
 * emitted by the publisher — so this profile is deliberately its own constant
 * rather than a relaxation of `RICHTEXT_CONFIG`, which IS on the published
 * path and must stay as tight as it is.
 */
const BOARD_DOC_CONFIG: Config = {
  ...RICHTEXT_CONFIG,
  ALLOWED_ATTR: [...(RICHTEXT_CONFIG.ALLOWED_ATTR ?? []), 'style', 'align'],
}

/**
 * Sanitize a board doc card's rich text (`DocBlock.html`). Call at every write
 * AND at every render — the write path covers what the editor produced, the
 * render path covers what an edited-by-hand `boards.json` contains.
 */
export function sanitizeBoardDocHtml(value: unknown): string {
  return sanitizeRichtext(value, BOARD_DOC_CONFIG)
}

/**
 * Strict config — strips ALL HTML tags; returns plain text only.
 * Use for single-line fields that should never contain markup.
 * Pass this to `sanitizeRichtext()` — it applies a post-strip pass to catch
 * any tags that DOMPurify's `ALLOWED_TAGS: []` might not catch in edge cases.
 */
export const PLAIN_TEXT_CONFIG: Config & { _plainText?: true } = {
  ALLOWED_TAGS: [],
  ALLOWED_ATTR: [],
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
  _plainText: true,  // sentinel: triggers regex post-strip pass in sanitizeRichtext()
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sanitize a richtext prop value using DOMPurify.
 *
 * Call this at EVERY write path before storing a richtext prop value in the store.
 * The value returned is safe to insert into an HTML page via the publisher pipeline.
 *
 * @param value  — raw user input (may contain malicious HTML)
 * @param config — DOMPurify config (defaults to RICHTEXT_CONFIG)
 * @returns sanitized HTML string, safe for publisher output
 */
export function sanitizeRichtext(
  value: unknown,
  config: Config & { _plainText?: true } = RICHTEXT_CONFIG,
): string {
  const str = String(value ?? '')
  if (!str.trim()) return ''

  // DOMPurify requires a live DOM-backed runtime. The browser has one
  // naturally; the Bun server installs an explicit runtime in
  // `server/richtextSanitizer.ts`. One-off scripts that do neither get the
  // conservative plain-text fallback.
  const purifier = getDOMPurify()
  if (!purifier || typeof purifier.sanitize !== 'function') {
    const stripped = stripHtmlFallback(str)
    return config._plainText ? stripped.trim() : stripped
  }

  const sanitized = sanitizeToFixpoint(purifier, str, config)

  // When plain-text mode is requested, apply a post-strip pass.
  // DOMPurify's ALLOWED_TAGS:[] covers most cases but certain browsers / DOM
  // implementations may preserve some inline elements. The fixpoint stripper is
  // the guaranteed fallback (and resists split-tag obfuscation).
  if (config._plainText) {
    return stripHtmlFallback(sanitized).trim()
  }

  return sanitized
}

/**
 * Check whether a module schema prop key refers to a richtext type.
 * Canonical key-name heuristic shared across layers (persistence validation,
 * the agent executor, and template binding resolution).
 */
export function isRichtextPropKey(key: string): boolean {
  const k = key.toLowerCase()
  return k === 'richtext' || k === 'html' || k.endsWith('html') || k.endsWith('richtext')
}

// ---------------------------------------------------------------------------
// SVG sanitisation
// ---------------------------------------------------------------------------

/**
 * SVG profile — allows the SVG + SVG-filter element/attribute set, blocks all
 * HTML (so `<foreignObject>` can't smuggle markup), scripts, and event
 * handlers. Used by the `base.svg` module so imported / pasted inline SVG
 * (logos, icons) round-trips and renders, while staying XSS-safe.
 *
 * `currentColor` and presentation attributes survive, so an SVG styled by a
 * CSS class (`fill: currentColor`) keeps inheriting the page's text colour.
 *
 * `href` / `xlink:href` stay forbidden, with ONE exception applied by the
 * `keepSvgFragmentHref` hook while this profile runs: a same-document fragment
 * (`#name`) on the elements that reference one. That is what makes
 * `<use href="#glyph">` sprites and gradient inheritance render instead of
 * silently drawing nothing. `<use>` itself is added back for the same reason:
 * DOMPurify drops it by default because a `<use>` pointing at a `data:` or
 * remote document can carry script, and with its `href` limited to a fragment
 * of THIS document it cannot.
 */
const SVG_CANVAS_CONFIG: Config = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_TAGS: ['use'],
  // Defence in depth — DOMPurify's svg profile already excludes these, but be
  // explicit: no HTML embedding, no script, no nested anchors carrying hrefs.
  FORBID_TAGS: ['script', 'foreignObject', 'a'],
  FORBID_ATTR: ['xlink:href', 'href'],
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
}

/**
 * The DEFAULT profile: the canvas one, plus the parser's SVG part stamps
 * (`data-studio-svg-part` / `-code`, P5-D SVG-3) removed as ATTRIBUTES, by the
 * sanitizer, on the DOM. Every exit (publish, export, the property control's
 * preview) gets them removed this way — never by editing the serialized markup
 * afterwards. Security review #269 B1: a regex strip run AFTER sanitizing
 * matched a look-alike stamp inside `<text>`, deleted across a tag boundary,
 * and turned sanitized markup into a live `<img onerror>`.
 */
const SVG_CONFIG: Config = {
  ...SVG_CANVAS_CONFIG,
  FORBID_ATTR: ['xlink:href', 'href', SVG_PART_ATTRIBUTE, SVG_CODE_ATTRIBUTE],
}

/**
 * Sanitise an inline-SVG markup string for safe inclusion in published HTML
 * and the editor canvas. Returns `''` when no DOMPurify runtime is available
 * (one-off scripts) — the browser and the Bun publish server both configure
 * one, so production paths always sanitise rather than drop.
 *
 * Call at every write path that stores an SVG prop (editor onChange, importer)
 * AND at the publisher boundary (`escapeProps`), per the "never trust the UI"
 * rule that governs richtext.
 *
 * Removes Studio's SVG part stamps unless `keepPartStamps` (the canvas render
 * only). Its output is final: nothing may edit it with string surgery.
 */
export function sanitizeSvg(value: unknown, options: { keepPartStamps?: boolean } = {}): string {
  const str = String(value ?? '')
  if (!str.trim()) return ''

  const purifier = getDOMPurify()
  if (!purifier || typeof purifier.sanitize !== 'function') {
    // No runtime: refuse to emit unsanitised markup. Stripping tags would
    // empty the SVG anyway, so return nothing.
    return ''
  }

  sanitizingSvg = true
  try {
    // Only the canvas render keeps the stamps: they are its hit test and the
    // address of every vector write (`SvgEditor.tsx`).
    return sanitizeToFixpoint(purifier, str, options.keepPartStamps ? SVG_CANVAS_CONFIG : SVG_CONFIG)
  } finally {
    sanitizingSvg = false
  }
}
