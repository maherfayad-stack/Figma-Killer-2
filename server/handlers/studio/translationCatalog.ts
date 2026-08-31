/**
 * translationCatalog — reads a project's OWN translation dictionary into a
 * flat, locale-keyed table the Content panel can render and edit.
 *
 * `localeProbe.ts` already answers "does this project have locales, and what
 * are their keys?" (`LocalesCapability`). It deliberately stops there: its job
 * is populating a `Select` before any page is parsed, so it reads KEYS and
 * never values. This module is the next question — "what does each locale
 * actually say?" — which is what an editing surface needs.
 *
 * ## The three shapes, and why they collapse to one table
 *
 * `LocalesCapability.source` names where the probe found the locales, and it
 * is one of two things: a FILE (a `translations[lang]` dictionary, or an
 * i18next-shaped `resources: { en, ar }` config) or a DIRECTORY
 * (`locales/*.json`, one file per locale). Both reduce to the same shape here
 * — `key -> { en: "...", ar: "..." }` — because that is the only shape an
 * editor can show side by side, and because the write path
 * (`setDictionaryEntry`) is addressed the same way regardless.
 *
 * ## Nested keys are flattened with dots, not dropped
 *
 * Real dictionaries nest (`{ nav: { home: "Home" } }`). A depth-1 reader would
 * silently show an object where a string belongs, or omit the entry entirely —
 * both lie about what the project contains. Nested objects flatten to
 * `nav.home`, which is the addressing every i18n library already uses and
 * round-trips back through the writer unchanged.
 *
 * **Parse, never execute.** ts-morph reads the written AST; a `.json` locale
 * file is `JSON.parse`d. No module is imported and no dictionary is evaluated,
 * so a dictionary built by a function call contributes only what is literally
 * written — see `objectLiteralEntries`.
 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Node, Project, SyntaxKind, type ObjectLiteralExpression, type SourceFile } from 'ts-morph'
import { readTextCapped } from './cappedFileRead'
import { resolveProjectProfile } from './projectProbe'
import { resolveAppRoot } from './appRoot'
import type { LocalesCapability } from './projectProfileSchema'

/** A dictionary file can be large, but not unbounded — the same posture every reader in this folder takes. */
export const MAX_DICTIONARY_BYTES = 512_000

/** One translatable string, across every locale the project declares. */
export interface TranslationEntry {
  /** Dot-addressed key as the dictionary writes it (`nav.home`). */
  key: string
  /** Locale key -> the literal string that locale holds. A locale missing this key simply has no entry — that absence is the "untranslated" state the panel renders. */
  values: Record<string, string>
}

export interface TranslationCatalog {
  capability: LocalesCapability
  /** Absolute path of the file (or directory) the entries came from — what a write targets. */
  sourceAbs: string
  /** `true` when `sourceAbs` is a directory of per-locale JSON files rather than one dictionary module. */
  perLocaleFiles: boolean
  entries: TranslationEntry[]
}

/**
 * Depth-1 string properties of an object literal, recursing into nested
 * object literals with a dotted prefix. A property whose value is neither a
 * string literal nor an object literal (a call, a template with
 * substitutions, a spread) is SKIPPED rather than stringified: the panel can
 * only honestly offer to edit a value it could also write back, and
 * `setDictionaryEntry` writes string literals.
 */
function objectLiteralEntries(literal: ObjectLiteralExpression, prefix: string, out: Map<string, string>): void {
  for (const property of literal.getProperties()) {
    if (!Node.isPropertyAssignment(property)) continue
    const nameNode = property.getNameNode()
    const name = Node.isStringLiteral(nameNode) ? nameNode.getLiteralValue() : nameNode.getText()
    const initializer = property.getInitializer()
    if (!initializer) continue
    const key = prefix ? `${prefix}.${name}` : name

    if (Node.isObjectLiteralExpression(initializer)) {
      objectLiteralEntries(initializer, key, out)
      continue
    }
    if (Node.isStringLiteral(initializer)) {
      out.set(key, initializer.getLiteralValue())
      continue
    }
    // A no-substitution template (`` `Hello` ``) is still a plain literal.
    if (Node.isNoSubstitutionTemplateLiteral(initializer)) out.set(key, initializer.getLiteralValue())
  }
}

/**
 * The locale-keyed object literal inside a dictionary module — the one whose
 * OWN depth-1 keys are the locale codes the probe reported.
 *
 * Matched by content rather than by variable name so the same reader handles
 * `const translations = { en, ar }` and `i18n.init({ resources: { en, ar } })`
 * without a second code path. The probe already told us which keys to expect,
 * which is what makes that identification safe instead of a guess.
 */
export function findLocaleRootLiteral(sourceFile: SourceFile, localeKeys: readonly string[]): ObjectLiteralExpression | undefined {
  const wanted = new Set(localeKeys)
  for (const literal of sourceFile.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
    const names = literal.getProperties().flatMap((p) => {
      if (!Node.isPropertyAssignment(p) && !Node.isShorthandPropertyAssignment(p)) return []
      const nameNode = p.getNameNode()
      return [Node.isStringLiteral(nameNode) ? nameNode.getLiteralValue() : nameNode.getText()]
    })
    if (names.length === 0) continue
    // Every declared locale must be present; extra keys are fine (a config
    // object can carry `lng`/`fallbackLng` beside its `resources`).
    if (localeKeys.every((key) => names.includes(key)) && names.some((n) => wanted.has(n))) return literal
  }
  return undefined
}

/** Reads a one-module dictionary (`translations.js`, an i18next config) into the flat table. */
function readDictionaryFile(absFile: string, capability: LocalesCapability): TranslationCatalog | null {
  const text = readTextCapped(absFile, MAX_DICTIONARY_BYTES)
  if (text === undefined) return null

  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true })
  const sourceFile = project.createSourceFile('dictionary.tsx', text)
  const root = findLocaleRootLiteral(sourceFile, capability.keys)
  if (!root) return null

  const byKey = new Map<string, Record<string, string>>()
  for (const property of root.getProperties()) {
    if (!Node.isPropertyAssignment(property)) continue
    const nameNode = property.getNameNode()
    const locale = Node.isStringLiteral(nameNode) ? nameNode.getLiteralValue() : nameNode.getText()
    if (!capability.keys.includes(locale)) continue
    const initializer = property.getInitializer()
    if (!initializer || !Node.isObjectLiteralExpression(initializer)) continue

    const flat = new Map<string, string>()
    objectLiteralEntries(initializer, '', flat)
    for (const [key, value] of flat) {
      const row = byKey.get(key) ?? {}
      row[locale] = value
      byKey.set(key, row)
    }
  }

  return {
    capability,
    sourceAbs: absFile,
    perLocaleFiles: false,
    entries: [...byKey].map(([key, values]) => ({ key, values })).sort((a, b) => a.key.localeCompare(b.key)),
  }
}

/** Flattens a parsed JSON locale file into dotted keys, skipping non-string leaves for the same reason `objectLiteralEntries` does. */
function flattenJson(value: unknown, prefix: string, out: Map<string, string>): void {
  if (typeof value === 'string') {
    if (prefix) out.set(prefix, value)
    return
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return
  for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
    flattenJson(child, prefix ? `${prefix}.${name}` : name, out)
  }
}

/** Reads a `locales/` directory of per-locale JSON files into the flat table. */
function readLocalesDirectory(absDir: string, capability: LocalesCapability): TranslationCatalog | null {
  const byKey = new Map<string, Record<string, string>>()
  let found = false

  for (const locale of capability.keys) {
    const absFile = join(absDir, `${locale}.json`)
    const text = readTextCapped(absFile, MAX_DICTIONARY_BYTES)
    if (text === undefined) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // A malformed locale file contributes nothing rather than failing the
      // whole catalogue — the other locales are still editable.
      continue
    }
    found = true
    const flat = new Map<string, string>()
    flattenJson(parsed, '', flat)
    for (const [key, value] of flat) {
      const row = byKey.get(key) ?? {}
      row[locale] = value
      byKey.set(key, row)
    }
  }
  if (!found) return null

  return {
    capability,
    sourceAbs: absDir,
    perLocaleFiles: true,
    entries: [...byKey].map(([key, values]) => ({ key, values })).sort((a, b) => a.key.localeCompare(b.key)),
  }
}

/**
 * This project's translation table, or `null` when it declares no locales at
 * all — which is NOT an error and NOT an empty table: "there is no dictionary
 * here" and "the dictionary is empty" are different facts, and the panel says
 * different things about them (offer to set Arabic up, versus show an empty
 * list). Never throws.
 */
export function readTranslationCatalog(dir: string): TranslationCatalog | null {
  const capability = resolveProjectProfile(dir).locales
  if (!capability) return null

  const appRootAbs = resolveAppRoot(dir)
  const sourceAbs = join(appRootAbs, ...capability.source.split('/'))
  if (!existsSync(sourceAbs)) return null

  try {
    return statSync(sourceAbs).isDirectory()
      ? readLocalesDirectory(sourceAbs, capability)
      : readDictionaryFile(sourceAbs, capability)
  } catch {
    return null
  }
}
