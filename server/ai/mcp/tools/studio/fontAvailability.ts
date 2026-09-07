/**
 * fontAvailability — the `font-not-available` quality finding (W9-3, strict
 * teeth).
 *
 * ## Why this is its own check, and why it is worth a rule
 *
 * A `font-family` naming a typeface the project cannot actually load is the
 * most expensive silent failure in this whole loop, because it does not look
 * like a font bug. The browser drops to the next family in the stack, the
 * screen still renders, `tsc` still passes, `studio_screenshot` still returns
 * a picture — and the fallback's x-height, cap-height and advance widths are
 * all different from the intended face. The agent then compares that
 * screenshot against the design, reads "the heading is too small / too
 * cramped / wraps a line early", and *fixes the font size*. Every size and
 * line-height it tunes from that point is tuned against the wrong typeface,
 * so the numbers drift further from the design with every pass that looks
 * locally like an improvement. Nothing else in `studio_quality_check` catches
 * it, and neither `studio_compare`'s score nor its regions can name it: a
 * whole screen rendered in the fallback face reads as thin, everywhere-slightly-
 * wrong diff, which is exactly the shape the verdict attributes to "a colour,
 * a font, or a global spacing value that is slightly off" — a diagnosis the
 * agent cannot act on without this finding.
 *
 * ## What "available" means here
 *
 * Deliberately generous, because the cost of a false positive (the agent
 * rewrites a font stack that was fine) is much higher than the cost of a
 * miss. A family counts as available if ANY of these is true:
 *
 *   - a generic or genuinely web-safe family (`sans-serif`, `system-ui`,
 *     `Arial`, `Segoe UI`, …) — see `ALWAYS_AVAILABLE_FAMILIES`;
 *   - an `@font-face { font-family: … }` in the page's own stylesheets, in
 *     the project's compiled CSS, or in its vendor CSS (the design system's
 *     own `dist/index.css` frequently ships the faces);
 *   - a `family=` parameter on a `fonts.googleapis.com` URL reached from a
 *     `<link>`/`@import` in one of the project's font-setup files;
 *   - a named import from `next/font/google` (`import { Inter } from
 *     'next/font/google'` makes `Inter` real);
 *   - a font FILE on disk under one of the conventional asset directories
 *     whose name matches the family (`public/fonts/Inter-Regular.woff2`
 *     covers `Inter`). A file that is on disk but never wired into an
 *     `@font-face` will not actually render — but "you have this font,
 *     something about the wiring is off" is a different, quieter problem than
 *     "this font does not exist here", and this rule refuses to shout the
 *     wrong one.
 *
 * ## Where it refuses to fire at all
 *
 * `next/font/local` anywhere in the scanned setup files switches the whole
 * check off for that project. A locally-registered Next font's family name is
 * generated (`__Inter_abc123`) and exposed through a CSS variable, so there
 * is no honest way to tell from static text whether a given family is one of
 * them. Under-reporting is the correct failure direction — the composition
 * rule that fired ~20 false positives per real hit was rejected outright
 * (see `qualityCheck.ts`'s module doc), and this rule is held to the same
 * bar.
 *
 * ## Posture
 *
 * Static and textual, like every other scan it sits beside: no CSS parser, no
 * execution, no network. Bounded everywhere — a fixed list of setup files, a
 * fixed list of asset directories at a shallow depth, a capped finding count.
 * Never throws: an unreadable file contributes nothing rather than failing
 * the audit.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { QualityFinding } from '../../../../handlers/studio/qualityAudit'
import { collectRootScopeMaps, resolveVarValue } from '../../../../handlers/studio/tokenExtractCssScan'
import type { PageStylesheet } from '@core/studio-sync/pageStylesheet'

/**
 * Families every browser resolves without the project declaring anything —
 * CSS generics, the `ui-*` system aliases, and the small set of faces that
 * are genuinely present across desktop platforms. `Roboto` and `Segoe UI` are
 * in here not because every machine has them but because they are the two
 * names that appear in almost every system font stack; flagging them would
 * make this rule fire on correct code.
 */
const ALWAYS_AVAILABLE_FAMILIES = new Set(
  [
    'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy',
    'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong',
    '-apple-system', 'blinkmacsystemfont', 'applesystemuifont',
    'segoeui', 'roboto', 'helveticaneue', 'helvetica', 'arial', 'arialblack',
    'timesnewroman', 'times', 'georgia', 'palatino', 'garamond', 'bookman',
    'couriernew', 'courier', 'verdana', 'tahoma', 'trebuchetms', 'impact', 'comicsansms',
    'segoeuiemoji', 'applecoloremoji', 'notocoloremoji', 'menlo', 'monaco', 'consolas', 'liberationmono',
    // CSS-wide keywords a `font-family` declaration can legitimately hold.
    'inherit', 'initial', 'unset', 'revert', 'revert-layer',
  ].map(normalizeFamily),
)

/** Font-setup files, in the conventions this repo's importer already recognises. A fixed list, not a walk: the point is to find `<link href="…googleapis…">`/`next/font` cheaply, not to read the project. */
const FONT_SETUP_FILES = [
  'index.html',
  'public/index.html',
  'app/layout.tsx',
  'src/app/layout.tsx',
  'pages/_app.tsx',
  'src/pages/_app.tsx',
  'pages/_document.tsx',
  'src/pages/_document.tsx',
  'src/main.tsx',
  'src/App.tsx',
]

/** Where a project keeps font files. Shallow, fixed, and bounded — never a whole-project walk. */
const FONT_ASSET_DIRS = ['public', 'static', 'assets', 'src/assets', 'src/fonts', 'public/fonts', 'app/fonts', 'src/styles/fonts']
const FONT_ASSET_MAX_DEPTH = 3
/** Bounds the disk walk so a `public/` full of images cannot turn one audit into a directory crawl. */
const FONT_ASSET_MAX_ENTRIES = 4000
const FONT_FILE_RE = /\.(woff2?|ttf|otf|eot)$/i
/** Weight/style/format suffixes stripped off a font FILE's stem before it is matched to a family — `Inter-SemiBoldItalic.woff2` is still the `Inter` family. */
const FONT_FILE_SUFFIX_RE = /(thin|extralight|ultralight|light|regular|normal|book|medium|semibold|demibold|bold|extrabold|ultrabold|black|heavy|italic|oblique|variable|vf|wght|[1-9]00)$/

/** Caps this one rule's contribution so a stylesheet with hundreds of `font-family` declarations cannot crowd out every other finding. */
const MAX_FONT_FINDINGS = 12

/** `@font-face { … font-family: X … }` — the block first, so a `font-family` in an ordinary rule can never be mistaken for a declaration of availability. */
const FONT_FACE_BLOCK_RE = /@font-face\s*\{([^{}]*)\}/gi
/** A `font-family` declaration (in a `@font-face` body or an ordinary rule). */
const FONT_FAMILY_DECLARATION_RE = /(^|[;{\s])font-family\s*:\s*([^;{}]+)/gi
/** A Google Fonts stylesheet URL's `family=` parameters, `css2`-style (`?family=Inter:wght@400&family=Lora`) and legacy (`?family=Inter|Lora`). */
const GOOGLE_FONTS_URL_RE = /fonts\.googleapis\.com\/[^"'\s)]*/gi
/** `import { Inter, Roboto_Mono } from 'next/font/google'` — the specifier list only. */
const NEXT_FONT_GOOGLE_IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*['"]next\/font\/google['"]/g

/** Lowercase, unquote, and strip every separator — so `"Helvetica Neue"`, `Helvetica-Neue` and `helvetica_neue` are one family. */
function normalizeFamily(raw: string): string {
  return raw
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .toLowerCase()
    .replace(/[\s_\-.]/g, '')
}

/** 1-based line of `index` in `text`. Local to this module for the same reason `qualityAudit.ts` keeps its own: a three-line text helper is not an abstraction worth sharing across a package boundary. */
function lineAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1
  }
  return line
}

/** Splits a `font-family` value into its stack, respecting quoted families that contain commas. Textual, like everything else here. */
function splitFontStack(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

function readFileOrEmpty(absPath: string): string {
  try {
    return readFileSync(absPath, 'utf8')
  } catch {
    return ''
  }
}

/** Every `@font-face`-declared family in one CSS text. */
function fontFaceFamilies(css: string): string[] {
  const families: string[] = []
  for (const block of css.matchAll(FONT_FACE_BLOCK_RE)) {
    const body = block[1] ?? ''
    for (const declaration of body.matchAll(FONT_FAMILY_DECLARATION_RE)) {
      for (const family of splitFontStack(declaration[2] ?? '')) families.push(family)
    }
  }
  return families
}

/** Every family named by a Google Fonts stylesheet URL appearing in `text`. */
function googleFontFamilies(text: string): string[] {
  const families: string[] = []
  for (const url of text.matchAll(GOOGLE_FONTS_URL_RE)) {
    const query = url[0].split('?')[1]
    if (!query) continue
    for (const param of query.split('&')) {
      if (!param.startsWith('family=')) continue
      const value = decodeURIComponent(param.slice('family='.length).replace(/\+/g, ' '))
      // `css2` scopes axes after a colon (`Inter:wght@400..700`); the legacy
      // API separates families with `|` and axes with `:`.
      for (const entry of value.split('|')) {
        const name = entry.split(':')[0]
        if (name) families.push(name)
      }
    }
  }
  return families
}

/** Every family made real by a `next/font/google` named import. `Roboto_Mono` is the family `Roboto Mono`; `normalizeFamily` erases the difference anyway. */
function nextFontGoogleFamilies(text: string): string[] {
  const families: string[] = []
  for (const match of text.matchAll(NEXT_FONT_GOOGLE_IMPORT_RE)) {
    for (const specifier of (match[1] ?? '').split(',')) {
      const name = specifier.split(/\s+as\s+/)[0]?.trim()
      if (name) families.push(name)
    }
  }
  return families
}

/** Font files under the conventional asset directories, as family candidates. Bounded by depth and by total entries visited. */
function fontFilesOnDisk(dir: string): { families: string[]; files: string[] } {
  const families: string[] = []
  const files: string[] = []
  let visited = 0

  const walk = (absDir: string, relDir: string, depth: number): void => {
    if (depth > FONT_ASSET_MAX_DEPTH || visited >= FONT_ASSET_MAX_ENTRIES) return
    let entries: string[]
    try {
      entries = readdirSync(absDir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (visited >= FONT_ASSET_MAX_ENTRIES) return
      visited += 1
      const abs = join(absDir, entry)
      const rel = relDir ? `${relDir}/${entry}` : entry
      let isDir: boolean
      try {
        isDir = statSync(abs).isDirectory()
      } catch {
        // A broken symlink or a file that vanished mid-walk contributes
        // nothing rather than failing the audit.
        continue
      }
      if (isDir) {
        walk(abs, rel, depth + 1)
        continue
      }
      if (!FONT_FILE_RE.test(entry)) continue
      files.push(rel)
      const stem = entry.replace(FONT_FILE_RE, '')
      // `Inter-SemiBold` -> `Inter`; strip at most one trailing style token so
      // a family whose own name ends in one (`Archivo Black`) survives as both
      // `archivoblack` and `archivo`.
      families.push(stem)
      const stripped = normalizeFamily(stem).replace(FONT_FILE_SUFFIX_RE, '')
      if (stripped.length >= 3) families.push(stripped)
    }
  }

  for (const relDir of FONT_ASSET_DIRS) {
    const abs = join(dir, ...relDir.split('/'))
    if (existsSync(abs)) walk(abs, relDir, 1)
  }
  return { families, files }
}

/**
 * Everything the project can actually render, resolved ONCE per
 * `studio_quality_check` call and reused for every page — the disk walk and
 * the setup-file reads are workspace facts, not per-page ones.
 */
export interface FontAvailability {
  /** Normalised family names (see `normalizeFamily`). */
  readonly families: ReadonlySet<string>
  /** Original spellings, for the "what you DO have" half of a finding's message. Capped at the point of use. */
  readonly declared: readonly string[]
  /** Font files found on disk, workspace-relative — evidence for a "the file is there, the @font-face is not" message. */
  readonly fontFiles: readonly string[]
  /** `--token` -> value, from the project's compiled CSS, so a `font-family: var(--font-body)` stack can be resolved before it is judged. */
  readonly cssVariables: ReadonlyMap<string, string>
  /** True when `next/font/local` was seen — the whole check stands down. See the module doc. */
  readonly suppressed: boolean
}

export function collectFontAvailability(dir: string, projectCss: readonly string[]): FontAvailability {
  const declared: string[] = []
  let suppressed = false

  for (const css of projectCss) {
    declared.push(...fontFaceFamilies(css))
    declared.push(...googleFontFamilies(css))
  }

  for (const relFile of FONT_SETUP_FILES) {
    const abs = join(dir, ...relFile.split('/'))
    if (!existsSync(abs)) continue
    const text = readFileOrEmpty(abs)
    if (text.includes('next/font/local')) suppressed = true
    declared.push(...googleFontFamilies(text))
    declared.push(...nextFontGoogleFamilies(text))
    declared.push(...fontFaceFamilies(text))
  }

  const { families: fileFamilies, files } = fontFilesOnDisk(dir)
  declared.push(...fileFamilies)

  const cssVariables = new Map<string, string>()
  for (const css of projectCss) {
    for (const [name, value] of collectRootScopeMaps(css).light) cssVariables.set(name, value)
  }

  return {
    families: new Set(declared.map(normalizeFamily)),
    declared,
    fontFiles: files,
    cssVariables,
    suppressed,
  }
}

/**
 * The `font-not-available` findings for one page's own stylesheets.
 *
 * Only the FIRST family in each stack is judged: the rest of a stack is the
 * fallback chain, and a fallback naming a face the machine may not have is
 * the entire point of having one. The first family is the one the design was
 * drawn in, and it is the only one whose absence silently changes every
 * metric on the screen.
 *
 * `@font-face` blocks inside the page's own sheets are collected first and
 * unioned into availability, so a page that declares its own face and then
 * uses it is never flagged — regardless of what the project-level scan found.
 */
export function auditFontAvailability(
  sheets: readonly PageStylesheet[],
  availability: FontAvailability,
): QualityFinding[] {
  if (availability.suppressed) return []

  const texts = sheets.map((sheet) => ({ relPath: sheet.relPath, text: readFileOrEmpty(sheet.absPath) }))
  const available = new Set(availability.families)
  for (const { text } of texts) {
    for (const family of fontFaceFamilies(text)) available.add(normalizeFamily(family))
    for (const family of googleFontFamilies(text)) available.add(normalizeFamily(family))
  }

  const findings: QualityFinding[] = []
  const alreadyReported = new Set<string>()

  for (const { relPath, text } of texts) {
    for (const declaration of text.matchAll(FONT_FAMILY_DECLARATION_RE)) {
      if (findings.length >= MAX_FONT_FINDINGS) return findings
      const rawValue = (declaration[2] ?? '').trim()
      // A `@font-face`'s own `font-family` DECLARES a family, it does not use
      // one — judging it would flag every project that ships its own fonts.
      if (isInsideFontFace(text, declaration.index ?? 0)) continue

      // Resolve the FIRST stack entry through the project's own custom
      // properties before judging it: `font-family: var(--font-display),
      // sans-serif` is the token-driven spelling of the same declaration, and
      // a rule that could not see through it would be blind on exactly the
      // projects that follow the prompt's own token rule. Resolved per entry,
      // not over the whole value, because `resolveVarValue` only answers a
      // value that IS a single `var()`.
      const stack = splitFontStack(rawValue)
      const head = stack[0]
      if (!head) continue
      const resolvedStack = splitFontStack(resolveVarValue(head, availability.cssVariables))
      const first = resolvedStack[0]
      if (!first) continue
      // An unresolved `var(--…)` (a token declared somewhere this scan cannot
      // see) is not evidence of a missing font — say nothing.
      if (first.includes('var(')) continue
      const normalized = normalizeFamily(first)
      if (normalized.length === 0) continue
      if (ALWAYS_AVAILABLE_FAMILIES.has(normalized) || available.has(normalized)) continue
      if (alreadyReported.has(normalized)) continue
      alreadyReported.add(normalized)

      const fallback = resolvedStack[1] ?? stack[1]
      findings.push({
        code: 'font-not-available',
        file: relPath,
        line: lineAt(text, declaration.index ?? 0),
        selector: `font-family: ${rawValue}`,
        message: buildMessage(first, fallback, availability),
      })
    }
  }

  return findings
}

/** True when `index` falls inside an `@font-face { … }` block — a declaration of availability, not a use of it. */
function isInsideFontFace(text: string, index: number): boolean {
  for (const block of text.matchAll(FONT_FACE_BLOCK_RE)) {
    const start = block.index ?? 0
    if (index >= start && index < start + block[0].length) return true
  }
  return false
}

function buildMessage(family: string, fallback: string | undefined, availability: FontAvailability): string {
  const spelled = family.replace(/^['"]|['"]$/g, '')
  const fell = fallback
    ? `the browser silently renders this in ${fallback.replace(/^['"]|['"]$/g, '')} instead`
    : 'the browser silently renders this in its own default face instead'
  const knownFiles = availability.fontFiles
    .filter((file) => normalizeFamily(file.split('/').pop() ?? '').includes(normalizeFamily(spelled)))
    .slice(0, 3)
  const fileHint = knownFiles.length > 0
    ? ` A matching font file IS on disk (${knownFiles.join(', ')}) but nothing declares an @font-face for it — wire that file up rather than changing the family.`
    : ''
  const options = uniqueSpellings(availability.declared).slice(0, 8)
  const haveHint = options.length > 0
    ? ` Families this project can actually render: ${options.join(', ')}.`
    : ' This project declares no @font-face, links no web font, and has no font file on disk — every custom family will fall back.'
  return `"${spelled}" is the first family in this stack, but the project declares no @font-face for it, links no web font by that name, and has no matching font file on disk — so ${fell}. This is not a cosmetic difference: the fallback's x-height and advance widths are different, so the screen reads as "the type is the wrong size" and every font-size or line-height tuned against a screenshot from here on is tuned against the wrong typeface.${fileHint}${haveHint}`
}

/** Original spellings, de-duplicated on their normalised form, order preserved. */
function uniqueSpellings(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const spelled = value.trim().replace(/^['"]|['"]$/g, '')
    const key = normalizeFamily(spelled)
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    out.push(spelled)
  }
  return out
}
