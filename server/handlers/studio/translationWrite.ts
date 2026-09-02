/**
 * translationWrite — sets one `(locale, key)` to a value in the project's own
 * dictionary, which is what makes the Content panel an EDITOR rather than a
 * viewer.
 *
 * It lives beside `translationCatalog.ts` rather than in
 * `src/core/ast-codemods/` on purpose. That module's subject is JSX writeback
 * — "what does this element/attribute say" — and every entry in it is
 * addressed by a `(file, line, col)` JSX location. A dictionary entry is
 * addressed by `(locale, dotted key)` and is not JSX at all. More practically,
 * the hard part of writing one is identifying the locale-root object literal,
 * and `findLocaleRootLiteral` is the reader's own answer to that question:
 * sharing it means the writer can never target a literal the reader did not
 * show the user.
 *
 * ## Creating what is missing, which is the normal case
 *
 * The whole point of the panel is filling in Arabic that does not exist yet,
 * so "the key is absent from this locale" is the expected state, not an error:
 * a missing `ar` branch, a missing intermediate object for a dotted key
 * (`nav.home` where `nav` has no entry), and a missing leaf are all created.
 * What is NOT created is the locale root itself — if the dictionary has no
 * `ar` key at all the project has not declared that locale, and inventing one
 * would write a locale the app never reads.
 *
 * ## What it refuses
 *
 * An existing value that is not a plain string literal (a call, a template
 * with substitutions, an array) is refused rather than overwritten. That
 * value is code the panel could not have displayed honestly in the first
 * place, and replacing it with a string would silently change behaviour —
 * the same posture `insertJsxIntoSlotProp` takes on an ambiguous slot.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IndentationText, Node, Project, QuoteKind, type ObjectLiteralExpression } from 'ts-morph'
import { readTextCapped } from './cappedFileRead'
import { findLocaleRootLiteral, readTranslationCatalog, MAX_DICTIONARY_BYTES } from './translationCatalog'

export type TranslationWriteResult = { ok: true } | { ok: false; message: string }

/** A JS string literal with the file's own quote style — single, matching every other codemod that synthesizes source here. */
function stringLiteral(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
}

/**
 * The object literal at `path` under `root`, creating any missing level as an
 * empty object literal. `undefined` when a level exists but is NOT an object
 * literal — an existing `nav: getNav()` cannot be descended into, and
 * replacing it would discard whatever it computes.
 */
function descend(root: ObjectLiteralExpression, path: readonly string[]): ObjectLiteralExpression | undefined {
  let current = root
  for (const segment of path) {
    const existing = current.getProperty(segment) ?? current.getProperty(`'${segment}'`) ?? current.getProperty(`"${segment}"`)
    if (existing) {
      if (!Node.isPropertyAssignment(existing)) return undefined
      const initializer = existing.getInitializer()
      if (!initializer || !Node.isObjectLiteralExpression(initializer)) return undefined
      current = initializer
      continue
    }
    const added = current.addPropertyAssignment({ name: segment, initializer: '{}' })
    const initializer = added.getInitializer()
    if (!initializer || !Node.isObjectLiteralExpression(initializer)) return undefined
    current = initializer
  }
  return current
}

/** Sets `locale.key` in a one-module dictionary. */
function writeDictionaryFile(
  absFile: string,
  localeKeys: readonly string[],
  locale: string,
  key: string,
  value: string,
): TranslationWriteResult {
  const text = readTextCapped(absFile, MAX_DICTIONARY_BYTES)
  if (text === undefined) return { ok: false, message: 'The dictionary file could not be read.' }

  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    // A dictionary write creates whole nested objects (`page: { signOut: … }`)
    // in a file the user reads and edits, so it matches the corpus's own
    // 2-space, single-quote style rather than ts-morph's 4-space default.
    manipulationSettings: { quoteKind: QuoteKind.Single, indentationText: IndentationText.TwoSpaces },
  })
  const sourceFile = project.createSourceFile('dictionary.tsx', text)
  const root = findLocaleRootLiteral(sourceFile, localeKeys)
  if (!root) return { ok: false, message: 'Studio could not find the locale table in the dictionary file.' }

  const localeProperty = root.getProperty(locale) ?? root.getProperty(`'${locale}'`) ?? root.getProperty(`"${locale}"`)
  if (!localeProperty || !Node.isPropertyAssignment(localeProperty)) {
    return { ok: false, message: `This project's dictionary has no "${locale}" locale to write into.` }
  }
  const localeLiteral = localeProperty.getInitializer()
  if (!localeLiteral || !Node.isObjectLiteralExpression(localeLiteral)) {
    return { ok: false, message: `The "${locale}" locale is not a plain object, so Studio won't write into it.` }
  }

  const segments = key.split('.')
  const leafName = segments[segments.length - 1]!
  const parent = descend(localeLiteral, segments.slice(0, -1))
  if (!parent) {
    return { ok: false, message: `"${key}" sits under a computed value in this dictionary, so Studio can't write it.` }
  }

  const existing = parent.getProperty(leafName) ?? parent.getProperty(`'${leafName}'`) ?? parent.getProperty(`"${leafName}"`)
  if (existing) {
    if (!Node.isPropertyAssignment(existing)) {
      return { ok: false, message: `"${key}" is not a plain property in this dictionary.` }
    }
    const initializer = existing.getInitializer()
    if (initializer && !Node.isStringLiteral(initializer) && !Node.isNoSubstitutionTemplateLiteral(initializer)) {
      return {
        ok: false,
        message: `"${key}" currently holds an expression (${initializer.getText().slice(0, 40)}), not a plain string — Studio won't overwrite code with text.`,
      }
    }
    existing.setInitializer(stringLiteral(value))
  } else {
    parent.addPropertyAssignment({ name: leafName, initializer: stringLiteral(value) })
  }

  writeFileSync(absFile, sourceFile.getFullText(), 'utf8')
  return { ok: true }
}

/** Sets a dotted key inside a parsed JSON object, creating intermediate objects. */
function setNested(target: Record<string, unknown>, segments: readonly string[], value: string): boolean {
  let current = target
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment]
    if (next === undefined) {
      const created: Record<string, unknown> = {}
      current[segment] = created
      current = created
      continue
    }
    if (typeof next !== 'object' || next === null || Array.isArray(next)) return false
    current = next as Record<string, unknown>
  }
  current[segments[segments.length - 1]!] = value
  return true
}

/** Sets `locale.key` in a `locales/<locale>.json` file. */
function writeLocaleJson(absDir: string, locale: string, key: string, value: string): TranslationWriteResult {
  const absFile = join(absDir, `${locale}.json`)
  const text = readTextCapped(absFile, MAX_DICTIONARY_BYTES)
  // An absent locale file is created — the directory IS the declared locale
  // set, so a locale the probe reported with no file yet is a gap to fill,
  // not a refusal.
  let parsed: Record<string, unknown> = {}
  if (text !== undefined) {
    try {
      const value_ = JSON.parse(text) as unknown
      if (typeof value_ !== 'object' || value_ === null || Array.isArray(value_)) {
        return { ok: false, message: `${locale}.json is not a JSON object.` }
      }
      parsed = value_ as Record<string, unknown>
    } catch {
      return { ok: false, message: `${locale}.json is not valid JSON, so Studio won't rewrite it.` }
    }
  }

  if (!setNested(parsed, key.split('.'), value)) {
    return { ok: false, message: `"${key}" collides with a non-object value in ${locale}.json.` }
  }
  writeFileSync(absFile, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  return { ok: true }
}

/** Sets one `(locale, key)` in whichever dictionary shape this project uses. Never throws. */
export function writeTranslationEntry(
  dir: string,
  entry: { locale: string; key: string; value: string },
): TranslationWriteResult {
  try {
    const catalog = readTranslationCatalog(dir)
    if (!catalog) return { ok: false, message: 'This project has no locale dictionary to write into.' }
    if (!catalog.capability.keys.includes(entry.locale)) {
      return { ok: false, message: `"${entry.locale}" is not a locale this project declares.` }
    }
    if (!entry.key.trim()) return { ok: false, message: 'A translation key is required.' }

    return catalog.perLocaleFiles
      ? writeLocaleJson(catalog.sourceAbs, entry.locale, entry.key, entry.value)
      : writeDictionaryFile(catalog.sourceAbs, catalog.capability.keys, entry.locale, entry.key, entry.value)
  } catch (err) {
    console.error('[studio:translationWrite]', err)
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
