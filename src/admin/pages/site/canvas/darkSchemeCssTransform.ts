/**
 * darkSchemeCssTransform — WS-10 Phase 1 §3.2: rewrites `@media
 * (prefers-color-scheme: dark|light)` blocks in the INJECTED COPY of a
 * project's CSS into unconditional, specificity-neutral selector rules gated
 * on a Studio-controlled attribute.
 *
 * ## Why this exists at all
 *
 * `prefers-color-scheme` is a real user-preference media feature. It resolves
 * from the browser/OS, is NOT inherited into an iframe as a value the canvas
 * can override, and cannot be forced per-frame from CSS (DevTools emulates it
 * over CDP, which is not available to us in-app). So toggling Studio's own
 * dark-mode preview to "dark" would do nothing on a host whose OS is set to
 * light — and, just as importantly, toggling it to "light" would NOT
 * suppress a dark override on a host whose OS is set to dark. Both
 * directions are broken by leaving the media query alone.
 *
 * The fix: at injection time, replace the ENTIRE media-query gate with a
 * selector gate driven by an attribute Studio itself controls
 * (`html[data-studio-scheme]`, set by `IframeFrameSurface.tsx`). The rewrite
 * therefore does not depend on host OS preference in either direction.
 *
 * `@media (prefers-color-scheme: light)` is rewritten too, for the same
 * reason in the other direction: a project that explicitly styles for light
 * via a media query (rarer, but real) would otherwise leak through on a
 * dark-OS host even while Studio previews "light".
 *
 * Applied at THREE injection points, never to the file on disk:
 * `UserStylesheetInjector.tsx` and `ProjectCssInjector.tsx` (WS-10 §3.4,
 * raw CSS text) and `ClassStyleInjector.tsx` (added after the initial Phase 1
 * landing — coordinator audit, 2026-08-01: an imported project's OWN
 * `@media (prefers-color-scheme: dark)`, and the identical condition a user
 * can author by hand via `ConditionBuilder.tsx`'s "Dark mode" preset, are
 * both parsed into the structured `site.styleRules` registry and re-emitted
 * as real CSS TEXT through `generateCanvasClassCSS`/`generateClassCSS` — this
 * function doesn't care whether its input came from a raw `.css` file or a
 * structured-registry re-emission, only that the text shape matches). Compare
 * `ProjectCssInjector`'s existing read-only `@layer vendor` posture: this is
 * the same "injected copy, never the source" discipline applied to a
 * different piece of CSS.
 *
 * **`generateClassCSS`/`createStyleRuleCssEmitter` (`@core/publisher`) are
 * NEVER touched.** Those are shared with the PUBLISHED page, which runs in a
 * real visitor's browser where `prefers-color-scheme` resolves correctly —
 * rewriting it there would ship a permanently-light (or permanently-dark)
 * site. The rewrite is applied to the GENERATED TEXT, strictly after
 * `ClassStyleInjector.tsx` calls the shared generator, so the publisher's own
 * call to the identical generator is provably unaffected. See
 * `styleRuleDarkModeRoundTrip.test.ts` for the test that pins this: it
 * asserts the publisher path still emits the real `@media` query from the
 * SAME generated string the canvas rewrites.
 *
 * ## How it avoids risk §7.2 ("mangles nested at-rules")
 *
 * A single greedy/non-greedy regex trying to capture `@media ... { ... }` as
 * one span breaks the instant the block contains ANY nested braces (a
 * `@supports` or another `@media` inside the dark block, a `content: "{"`
 * declaration, …) — non-greedy stops at the FIRST `}`, greedy over-consumes
 * to the LAST one in the whole file. `findPrefersColorSchemeBlocks` below
 * instead walks the text char-by-char tracking brace depth (correctly
 * matching nested braces) and comment/string state (so a `/* ... *\/` or a
 * quoted string containing stray braces never desyncs the count).
 *
 * The CSSOM (`getSheetConstructor`, the same acquisition `cssToStyleRules.ts`
 * uses — browser-native, or happy-dom's `GlobalWindow` under `bun test`) is
 * used to VALIDATE each candidate: only a prelude that parses as a real,
 * singular `CSSMediaRule` is accepted, so a coincidental brace-balanced span
 * that merely LOOKS like `@media (prefers-color-scheme: dark) { ... }` can
 * never be spliced in as if it were one. The candidate is validated in
 * ISOLATION (`@media <prelude> {}`, never the whole stylesheet) — feeding the
 * whole file through this CSSOM is NOT safe: happy-dom's CSS parser does not
 * support `@layer` at all and silently drops every rule inside one, which
 * would corrupt a Tailwind v4 project's CSS (wrapped entirely in
 * `@layer theme, base, components, utilities;`) if this module ever
 * round-tripped the full text through it. Everything outside a matched span —
 * `@layer` wrappers included — is left byte-for-byte untouched; only the
 * exact matched `@media (...) { ... }` text is replaced.
 *
 * ## Specificity neutrality
 *
 * `:where(...)` has zero specificity by spec. The wrapper is
 * `:where(html[data-studio-scheme='dark']) { <inner, byte-preserved> }` — CSS
 * nesting (universally supported in the evergreen browsers Studio targets)
 * gives each inner rule's effective selector an implicit
 * `:where(...) <descendant>` combinator, so `.btn { padding: 8px }` becomes
 * `:where(html[data-studio-scheme='dark']) .btn { padding: 8px }`. Because
 * `html` is always an ancestor of every element in the document, this matches
 * EXACTLY the same elements the original (unscoped, inside the media query)
 * `.btn` selector matched — the rewrite changes *when* the rule applies
 * (attribute gate instead of media gate), never *what* it matches or how
 * strongly it wins a specificity fight. `docs/features/canvas-iframe-per-frame.md`
 * documents this as a targeted, narrow exception to "no selector rewriting":
 * unlike a wrapper `<div>`, nothing here changes the DOM the selectors match
 * against — only the CONDITION under which a media-gated block applies, and
 * only inside the injected copy.
 */
import { getSheetConstructor } from '@core/siteImport'

/** Set on the frame's `<html>` by `IframeFrameSurface.tsx`, always `'light'` or `'dark'` (never absent) once a frame has mounted. */
export const DARK_SCHEME_ATTR = 'data-studio-scheme'

interface MediaBlockSpan {
  /** Index of the `@` starting `@media`. */
  start: number
  /** Index just past the matching closing `}`. */
  end: number
  /** Index of the block's opening `{`. */
  bodyStart: number
  /** Index of the block's matching closing `}`. */
  bodyEnd: number
  /** Raw text between `@media` and `{`, untrimmed. */
  preludeText: string
}

/** Advances past a `'...'`/`"..."` string literal starting at `css[start]`, honouring backslash escapes. Returns the index just past the closing quote (or the string end if unterminated). */
function skipString(css: string, start: number): number {
  const quote = css[start]
  let i = start + 1
  while (i < css.length) {
    if (css[i] === '\\') { i += 2; continue }
    if (css[i] === quote) return i + 1
    i++
  }
  return css.length
}

/**
 * Walks `css` char-by-char (comment/string aware) locating every `@media`
 * occurrence — at ANY nesting depth, so one inside `@layer`/`@supports`/
 * another `@media` is found exactly the same way a top-level one is — and
 * returns each one's full brace-balanced span. A match whose braces never
 * balance (malformed CSS) is skipped, not corrupted. Once a span is found,
 * scanning resumes AFTER it: a `prefers-color-scheme` query nested INSIDE an
 * already-matched dark/light block is left alone (rare in practice, and its
 * surrounding block's content is preserved verbatim either way, so nothing
 * is lost — only not independently rewritten).
 */
function findMediaBlocks(css: string): MediaBlockSpan[] {
  const spans: MediaBlockSpan[] = []
  const n = css.length
  let i = 0

  while (i < n) {
    const ch = css[i]
    if (ch === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2)
      i = close === -1 ? n : close + 2
      continue
    }
    if (ch === '"' || ch === "'") {
      i = skipString(css, i)
      continue
    }
    if (ch === '@' && css.startsWith('@media', i) && !/[A-Za-z0-9_-]/.test(css[i + 6] ?? '')) {
      const blockStart = i
      let j = i + 6
      let preludeEnd = -1
      while (j < n) {
        const c = css[j]
        if (c === '/' && css[j + 1] === '*') {
          const close = css.indexOf('*/', j + 2)
          j = close === -1 ? n : close + 2
          continue
        }
        if (c === '"' || c === "'") { j = skipString(css, j); continue }
        if (c === '{') { preludeEnd = j; break }
        // A `;` or unmatched `}` before any `{` means this wasn't a block
        // media rule after all (e.g. the literal text appeared somewhere
        // unexpected) — bail without consuming it as a match.
        if (c === ';' || c === '}') break
        j++
      }
      if (preludeEnd === -1) { i = blockStart + 6; continue }

      let depth = 1
      let k = preludeEnd + 1
      while (k < n && depth > 0) {
        const c = css[k]
        if (c === '/' && css[k + 1] === '*') {
          const close = css.indexOf('*/', k + 2)
          k = close === -1 ? n : close + 2
          continue
        }
        if (c === '"' || c === "'") { k = skipString(css, k); continue }
        if (c === '{') depth++
        else if (c === '}') depth--
        k++
      }
      if (depth !== 0) { i = blockStart + 6; continue }

      spans.push({
        start: blockStart,
        end: k,
        bodyStart: preludeEnd,
        bodyEnd: k - 1,
        preludeText: css.slice(blockStart + 6, preludeEnd).trim(),
      })
      i = k
      continue
    }
    i++
  }
  return spans
}

/** Whitespace/case-insensitive comparison against the two target conditions. CSSOM `conditionText` echoes its input back verbatim rather than normalizing it (verified against happy-dom), so this normalization is done here rather than trusted from the engine. */
function targetScheme(prelude: string): 'dark' | 'light' | null {
  const collapsed = prelude.replace(/\s+/g, '').toLowerCase()
  if (collapsed === '(prefers-color-scheme:dark)') return 'dark'
  if (collapsed === '(prefers-color-scheme:light)') return 'light'
  return null
}

const MEDIA_RULE_TYPE = 4 // CSSMediaRule, per the CSSOM spec — see cssToStyleRules.ts's same constant.

/**
 * Confirms `prelude` parses as a real, singular `@media` condition in
 * isolation (`@media <prelude> {}` — never the whole stylesheet, see this
 * module's doc for why). Returns `false` for anything that fails to parse
 * into exactly one `CSSMediaRule` — a defensive guard, not the scheme
 * classifier (that's `targetScheme` above, run on the ORIGINAL source text).
 */
function isValidMediaPrelude(prelude: string, SheetCtor: typeof CSSStyleSheet): boolean {
  try {
    const sheet = new SheetCtor()
    sheet.replaceSync(`@media ${prelude} {}`)
    return sheet.cssRules.length === 1 && sheet.cssRules[0]!.type === MEDIA_RULE_TYPE
  } catch {
    return false
  }
}

/**
 * Rewrites every `@media (prefers-color-scheme: dark|light)` block in `css`
 * into `:where(html[data-studio-scheme='<scheme>']) { <inner> }`. Everything
 * else — including surrounding `@layer`/`@supports` wrappers, comments,
 * formatting — is left byte-for-byte untouched. Returns `css` unchanged when
 * no CSS engine is available (defensive; `getSheetConstructor` already
 * degrades this way for `cssToStyleRules.ts`) or when nothing matches.
 */
export function rewritePrefersColorScheme(css: string, sheetConstructor?: typeof CSSStyleSheet): string {
  const SheetCtor = getSheetConstructor(sheetConstructor)
  if (!SheetCtor) return css
  if (!/prefers-color-scheme/i.test(css)) return css // cheap short-circuit — most CSS has no dark-mode media query at all

  const blocks = findMediaBlocks(css)
  if (blocks.length === 0) return css

  let out = css
  // Back-to-front so earlier, unprocessed spans' indices stay valid.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!
    const scheme = targetScheme(block.preludeText)
    if (!scheme) continue
    if (!isValidMediaPrelude(block.preludeText, SheetCtor)) continue
    const inner = css.slice(block.bodyStart + 1, block.bodyEnd)
    const replacement = `:where(html[${DARK_SCHEME_ATTR}='${scheme}']) {${inner}}`
    out = out.slice(0, block.start) + replacement + out.slice(block.end)
  }
  return out
}
