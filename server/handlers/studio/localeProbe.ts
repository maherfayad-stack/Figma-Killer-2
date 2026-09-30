/**
 * localeProbe — WS-10 §4.1's `LocalesCapability` detector: `dir → { keys,
 * defaultKey?, source } | null`. Split out as its own file for the same
 * reason `colorSchemeDetect.ts` is — kept out of `projectProbe.ts` to stay
 * under the module-size-budget ceiling, and because it is a self-contained,
 * independently-testable text scan.
 *
 * **Purely syntactic — a regex/text scan, never an execution**, same posture
 * as every other detector in `projectProbe.ts`. This is NOT the real §7.4
 * evaluator (`staticEvalCalls.ts`'s Tier B.4 dictionary-branch pick, which
 * runs during a real parse and needs a real AST) — it is a cheap, best-effort
 * PROJECT-SHAPE probe whose only job is populating a `Select`'s options and a
 * disabled-with-reason state before any page has been parsed at all.
 *
 * Detection order (first match wins), per §4.1:
 *   1. The dictionary object a `translations[lang]`-style index reads —
 *      exactly the shape Tier B.4 already resolves at parse time
 *      (`staticEvalCore.ts`'s `evaluateElementAccess`) — found by locating an
 *      `<name>[<indexExpr>]` element-access anywhere in the project, then the
 *      top-level object literal `<name>` is declared with (possibly in a
 *      DIFFERENT file — see `detectDictionaryIndex`'s own doc), and reading
 *      that literal's OWN immediate (depth-1) keys.
 *   2. An i18next/react-intl-shaped `resources: { en: {...}, ar: {...} }`
 *      config object literal.
 *   3. A `locales/*.json` (or `i18n/locales/*.json`) directory — one file per
 *      locale, the filename (minus `.json`) is the key.
 *
 * A project matching none of these degrades to `null` — `PreviewAxesControls.tsx`
 * renders the locale control disabled with a reason (WS-10 §7.4 "probe
 * honesty"), never a silent no-op `Select`.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isDesignSystemPath, listWorkspaceFiles } from '@core/page-parser'
import { readTextCapped } from './cappedFileRead'
import type { LocalesCapability } from './projectProfileSchema'

/** A locale-code-shaped object key: `en`, `ar`, `en-US`, `pt-BR`, `zh-Hans` — permissive enough for real-world variants, tight enough to reject an ordinary config key (`common`, `title`, `nav`). */
const LOCALE_KEY_RE = /^[a-z]{2,3}([-_][A-Za-z]{2,4})?$/

/**
 * Two-and-three-letter keys that fit {@link LOCALE_KEY_RE}'s shape but are
 * never a locale code in practice — an `{ ltr, rtl }` (or `{ ltr, rtl, auto }`)
 * direction map is the real-world case: it is exactly as shaped as `{ en, ar }`
 * and sits behind the same `map[dir]`-style dynamic index this scan looks for,
 * so the shape check alone cannot tell them apart. `test4`'s vendored
 * `Expander.jsx` carries one to pick padding by writing direction, and without
 * this denylist it was read back as the project's locale dictionary, flipping
 * `.studio/meta.json`'s locale axis from `['en', 'ar']` to `['ltr', 'rtl']`.
 */
const NON_LOCALE_KEYS = new Set(['ltr', 'rtl'])

/** Whether `key` both looks like a locale code and isn't one of the known shape-alikes. */
function isLocaleKey(key: string): boolean {
  return LOCALE_KEY_RE.test(key) && !NON_LOCALE_KEYS.has(key.toLowerCase())
}

/**
 * Studio's own scaffold always lands at `<src/>i18n/translations.ts`
 * (`i18nScaffold.ts`'s `defaultScaffoldDir`) — when a candidate dictionary
 * sits there, it is preferred over any other qualifying match the scan finds,
 * so a coincidental shape-alike elsewhere in the project never outranks the
 * dictionary Studio itself generated and the extraction codemod actually
 * writes into.
 */
function isStudioScaffoldDictionaryPath(relFile: string): boolean {
  return /(^|\/)i18n\/translations\.ts$/.test(relFile)
}

/** Object/array/string literal keys as JS source writes them: a bare identifier or a quoted string, immediately followed by `:`. */
const OBJECT_KEY_RE = /(?:([A-Za-z_$][\w$]*)|['"]([^'"]+)['"])\s*:/g

const CODE_EXT_RE = /\.(?:tsx|jsx|ts|js|mjs|cjs)$/

/**
 * Depth-1 keys of the object literal whose `{` sits at `text[openBraceIndex]`
 * — walks forward tracking `{}`/`[]`/`()` nesting and single/double/template
 * string state, collecting an `OBJECT_KEY_RE` match only when depth is
 * exactly 1 (i.e. a direct child of the literal, not a nested object's own
 * key). Stops at the literal's own closing `}`. Never throws; an unbalanced
 * or truncated literal (the capped read cut it off) just yields whatever
 * depth-1 keys were seen before that point.
 */
function extractTopLevelKeys(text: string, openBraceIndex: number): string[] {
  const keys: string[] = []
  let depth = 0
  let i = openBraceIndex
  let quote: '"' | "'" | '`' | null = null

  for (; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      if (ch === '\\') { i++; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (ch === '{' || ch === '[' || ch === '(') { depth++; continue }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth--
      if (depth === 0 && ch === '}') break // the literal's own closing brace
      continue
    }
    if (depth === 1 && (ch === '_' || /[A-Za-z'"]/.test(ch))) {
      OBJECT_KEY_RE.lastIndex = i
      const match = OBJECT_KEY_RE.exec(text)
      OBJECT_KEY_RE.lastIndex = 0
      if (match && match.index === i) {
        const key = match[1] ?? match[2]!
        keys.push(key)
        // Skip past the whole matched `key:` token (not just this one
        // character) — otherwise the next loop iteration re-attempts a match
        // starting mid-identifier (e.g. "nstall:" inside "install:"), which
        // can spuriously succeed and record a garbage key.
        i += match[0].length - 1
      }
    }
  }
  return keys
}

function pickDefaultKey(keys: string[]): string | undefined {
  return keys.includes('en') ? 'en' : keys[0]
}

/**
 * Rule 1 — the `translations[lang]`-style dynamic dictionary index Tier B.4
 * already resolves at parse time. The dictionary and the file that INDEXES
 * it are usually two different files (`translations.js` exports the object;
 * a `LanguageContext.jsx` elsewhere imports and indexes it) — confirmed
 * against the real eSIM fixture, so this cannot be a same-file-only scan.
 * Two passes: (1) find every top-level object-literal declaration in the
 * project, by name; (2) scan every file for a `<name>[<indexExpr>]` access
 * whose `<indexExpr>` is NOT itself a string/number literal (a literal
 * index, e.g. `sizes['md']`, is an ordinary lookup, not a language switcher)
 * and look `<name>` up in the pass-1 map.
 *
 * More than one candidate can qualify — a design system's own theming
 * sometimes indexes an unrelated two-key object dynamically too, and even
 * with the design-system folder excluded (see {@link detectLocales}) a user's
 * own code can coincidentally shape one the same way. Studio's own scaffold
 * (see {@link isStudioScaffoldDictionaryPath}) wins when it's among the
 * candidates; otherwise the first found in file-scan order, same as before.
 */
function detectDictionaryIndex(root: string, files: string[]): LocalesCapability | null {
  const codeFiles = files.filter((f) => CODE_EXT_RE.test(f))
  const fileTexts = new Map<string, string>()
  for (const relFile of codeFiles) {
    const text = readTextCapped(join(root, ...relFile.split('/')), 500_000)
    if (text) fileTexts.set(relFile, text)
  }

  const declarationRe = /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{/g
  const declarations = new Map<string, { file: string; openBraceIndex: number }>()
  for (const [relFile, text] of fileTexts) {
    declarationRe.lastIndex = 0
    let declMatch: RegExpExecArray | null
    while ((declMatch = declarationRe.exec(text)) !== null) {
      const name = declMatch[1]!
      if (!declarations.has(name)) {
        declarations.set(name, { file: relFile, openBraceIndex: declMatch.index + declMatch[0].length - 1 })
      }
    }
  }

  const candidatesBySource = new Map<string, LocalesCapability>()
  const accessRe = /\b([A-Za-z_$][\w$]*)\[\s*([A-Za-z_$][\w$]*)\s*\]/g
  for (const [, text] of fileTexts) {
    accessRe.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = accessRe.exec(text)) !== null) {
      const decl = declarations.get(match[1]!)
      if (!decl || candidatesBySource.has(decl.file)) continue
      const declText = fileTexts.get(decl.file)!
      const keys = extractTopLevelKeys(declText, decl.openBraceIndex).filter(isLocaleKey)
      if (keys.length < 2) continue
      candidatesBySource.set(decl.file, { keys, defaultKey: pickDefaultKey(keys), source: decl.file })
    }
  }
  if (candidatesBySource.size === 0) return null
  for (const candidate of candidatesBySource.values()) {
    if (isStudioScaffoldDictionaryPath(candidate.source)) return candidate
  }
  return candidatesBySource.values().next().value ?? null
}

/** Rule 2 — an i18next/react-intl-shaped `resources: { en: {...}, ar: {...} }` config object literal. */
function detectResourcesConfig(root: string, files: string[]): LocalesCapability | null {
  const resourcesRe = /\bresources\s*:\s*\{/
  for (const relFile of files) {
    if (!CODE_EXT_RE.test(relFile)) continue
    const absPath = join(root, ...relFile.split('/'))
    const text = readTextCapped(absPath, 500_000)
    if (!text) continue
    const match = resourcesRe.exec(text)
    if (!match) continue
    const openBrace = match.index + match[0].length - 1
    const keys = extractTopLevelKeys(text, openBrace).filter(isLocaleKey)
    if (keys.length < 2) continue
    return { keys, defaultKey: pickDefaultKey(keys), source: relFile }
  }
  return null
}

/** Rule 3 — a `locales/` (or `i18n/locales/`) directory holding one `.json` file per locale. */
function detectLocalesDirectory(root: string): LocalesCapability | null {
  const candidates = ['locales', join('src', 'locales'), join('i18n', 'locales'), join('src', 'i18n', 'locales')]
  for (const relDir of candidates) {
    const absDir = join(root, relDir)
    if (!existsSync(absDir)) continue
    let entries: string[]
    try {
      entries = readdirSync(absDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.json'))
        .map((e) => e.name.replace(/\.json$/, ''))
    } catch {
      continue
    }
    // Sorted — `readdirSync` order is filesystem-dependent, not source order
    // (there IS no "source order" for a directory of sibling files the way
    // there is for an object literal's keys), so a deterministic alphabetical
    // order is the honest choice rather than an accidental one.
    const keys = entries.filter(isLocaleKey).sort()
    if (keys.length < 2) continue
    return { keys, defaultKey: pickDefaultKey(keys), source: relDir.split('\\').join('/') }
  }
  return null
}

/**
 * `dir → LocalesCapability | null`, per this module's own doc — see there for
 * the three detection rules and their order.
 *
 * `design-system/` is Studio's own vendored copy of the built-in design
 * system (`isDesignSystemPath`), never the user's own dictionary — the same
 * exclusion `findHardcodedStrings` applies for the same reason: a library's
 * own internal object literals (an `{ ltr, rtl }` direction map keyed off
 * writing direction, in the real corpus that motivated this) are shaped just
 * like a locale dictionary and must never be read back as the project's.
 */
export function detectLocales(root: string): LocalesCapability | null {
  const files = listWorkspaceFiles(root).filter((f) => !isDesignSystemPath(f))
  return detectDictionaryIndex(root, files) ?? detectResourcesConfig(root, files) ?? detectLocalesDirectory(root)
}

/**
 * Whether a freshly-probed `locales` capability is safe to persist over
 * whatever `.studio/meta.json` already cached — `projectProbe.ts`'s
 * `reprobeProjectProfile` is the one caller, guarding its own merge.
 *
 * This scan is a best-effort syntactic one, not the real evaluator — it can
 * find a shape-alike (a two-key object literal, dynamically indexed) that is
 * not actually the project's locale dictionary. Once a project has a KNOWN
 * dictionary, a later probe that names a DIFFERENT source is exactly the
 * failure mode that flipped a real project's locale axis from
 * `['en', 'ar']` to `['ltr', 'rtl']` — a design-system direction map briefly
 * outranked the real `i18n/translations.ts`, before this module excluded that
 * folder and learned to prefer the Studio scaffold (above). Trusting a NEW
 * source over an already-known one has no such guard once this scan is wrong
 * for some other reason, so a probe that would change `locales.source` is
 * refused here and the previously known value wins instead. Agreeing on the
 * same source (updated keys for the same file) and going from "nothing
 * known" to "something found" both persist normally — this only refuses a
 * SWAP.
 */
export function reconcileLocales(
  previous: LocalesCapability | undefined,
  next: LocalesCapability | undefined,
): LocalesCapability | undefined {
  if (!previous) return next
  if (!next || next.source !== previous.source) return previous
  return next
}
