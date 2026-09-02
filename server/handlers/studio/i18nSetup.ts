/**
 * i18nSetup — `POST /admin/api/studio/i18n-setup`, the one action that takes a
 * project with no localisation at all and leaves it with English and Arabic.
 *
 * Four steps, in this order, because each depends on the last:
 *
 *   1. **Scaffold** `i18n/translations.ts` + `i18n/LanguageContext.tsx`
 *      (`i18nScaffold.ts` — read its doc for why the generated code has the
 *      exact shape it does), or, when the project ALREADY has Studio's
 *      dictionary, locate it and skip straight to step 2. Extraction is not a
 *      one-time event: a screen written after the first run, or a string the
 *      scanner learned to see later, is still inline and still needs moving.
 *   2. **Mint a key per string** the scanner found ({@link mintKeys}).
 *   3. **Rewrite the JSX**, one file at a time (`extractStringsToDictionary`).
 *   4. **Write the English value** for every key that actually landed, through
 *      the same `writeTranslationEntry` a hand edit in the panel uses.
 *
 * Step 4 is deliberately last and deliberately keyed off step 3's REPORT: a key
 * whose JSX rewrite was refused must not appear in the dictionary, or the panel
 * would offer to translate a string no screen reads.
 *
 * ## Why this is one action and not fifteen
 *
 * An earlier design had a "Localize this string" button per row. That is a
 * second way to do the same thing — the repo bans those — and it is the worse
 * one: the import and the hook call are a per-FILE decision, so fifteen
 * per-string actions would mean fifteen re-parses of the same file, each racing
 * the last one's positions. The list the panel already shows IS the preview:
 * the user sees exactly which strings will move before pressing the button.
 *
 * The Arabic side is left empty on purpose. Filling it is
 * `server/ai/handlers/translateContent.ts`'s job, offered as a separate,
 * explicit action — Studio does not silently spend a model call inside a
 * structural edit.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractStringsToDictionary, relativeSpecifier, type StringExtraction } from '@core/ast-codemods'
import { Type } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { projectsRootDir, resolveProjectDir } from '../studioProjects'
import { isRealpathContained } from './workspacePackageResolve'
import { resolveAppRoot } from './appRoot'
import { findHardcodedStrings, type HardcodedString } from './hardcodedStrings'
import { findScaffoldedI18n, scaffoldProjectI18n, SCAFFOLD_HOOK_NAME, SCAFFOLD_LOCALES } from './i18nScaffold'
import { readTranslationCatalog } from './translationCatalog'
import { reprobeProjectProfile } from './projectProbe'
import { writeTranslationEntry } from './translationWrite'

const ROUTE_PATH = '/admin/api/studio/i18n-setup'

const SetupBodySchema = Type.Object({ dir: Type.Optional(Type.String()) })

/** Longest a minted name may grow before it is truncated — long enough to stay readable, short enough to stay a key. */
const MAX_KEY_WORDS = 5

/**
 * A key segment that is a valid JS identifier, because the extraction writes
 * `t.<namespace>.<leaf>` as real source. `2 adults · Economy` shortens to
 * `2AdultsEconomy`, and `t.home.2AdultsEconomy` is a syntax error — one that
 * took down every other string in the same file when ts-morph refused the
 * edit. A leading digit gets an underscore rather than being dropped: `2` is
 * load-bearing in `2 adults`, and a key that silently loses it stops matching
 * the string it names.
 */
function identifierSegment(raw: string): string {
  return /^[0-9]/.test(raw) ? `_${raw}` : raw
}

/** `pages/Home.tsx` -> `home`. The namespace every key from that file sits under, so two screens can hold the same sentence with different translations. */
function namespaceFor(relFile: string): string {
  const base = relFile.split('/').pop() ?? relFile
  const stem = base.replace(/\.(tsx|jsx|ts|js)$/, '')
  const camel = stem.replace(/[^A-Za-z0-9]+(.)?/g, (_match, next: string | undefined) => (next ? next.toUpperCase() : ''))
  return identifierSegment(camel.charAt(0).toLowerCase() + camel.slice(1))
}

/** `"Book an airport transfer"` -> `bookAnAirportTransfer`. Empty when the text carries no usable letters. */
function leafFor(text: string): string {
  const words = text
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .slice(0, MAX_KEY_WORDS)
  if (words.length === 0) return ''
  const head = words[0]!.toLowerCase()
  const camel = head + words.slice(1).map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join('')
  return identifierSegment(camel)
}

export interface MintedKey extends HardcodedString {
  key: string
}

/**
 * A dictionary key per scanned string.
 *
 * Two strings with the SAME text in the same file share one key — "Add your
 * text here." appearing twice on a screen is one thing to translate, not two,
 * and two keys would mean translating it twice and letting the two drift. The
 * same text in a DIFFERENT file gets its own key: the same English sentence can
 * legitimately need different Arabic in a different context.
 *
 * A collision on the minted NAME (different text that shortens to the same
 * words) takes a numeric suffix rather than silently merging two strings.
 */
export function mintKeys(strings: readonly HardcodedString[]): MintedKey[] {
  const byText = new Map<string, string>()
  const taken = new Set<string>()
  const out: MintedKey[] = []

  for (const item of strings) {
    const namespace = namespaceFor(item.file)
    const textKey = `${namespace} ${item.text}`
    const existing = byText.get(textKey)
    if (existing) {
      out.push({ ...item, key: existing })
      continue
    }
    const leaf = leafFor(item.text)
    if (!leaf) continue
    let key = `${namespace}.${leaf}`
    for (let n = 2; taken.has(key); n++) key = `${namespace}.${leaf}${n}`
    taken.add(key)
    byText.set(textKey, key)
    out.push({ ...item, key })
  }
  return out
}

export interface I18nSetupFailure {
  key: string
  message: string
}

export interface I18nSetupReport {
  ok: true
  /** App-root-relative path of the dictionary the panel will read next. */
  source: string
  locales: readonly string[]
  /** Strings rewritten into `{t.key}` AND written into the English dictionary. */
  extracted: number
  filesChanged: number
  failures: I18nSetupFailure[]
}

/** Rewrites one file's strings and returns the keys that actually landed there. */
function rewriteFile(
  appRootAbs: string,
  relFile: string,
  minted: readonly MintedKey[],
  contextAbs: string,
  failures: I18nSetupFailure[],
): string[] {
  const absFile = join(appRootAbs, ...relFile.split('/'))
  const sourceText = readFileSync(absFile, 'utf8')
  const extractions: StringExtraction[] = minted.map((item) => ({
    line: item.line,
    col: item.col,
    text: item.text,
    key: item.key,
  }))

  const result = extractStringsToDictionary({
    sourceText,
    fileName: relFile.split('/').pop() ?? relFile,
    extractions,
    importSpecifier: relativeSpecifier(absFile, contextAbs),
    hookName: SCAFFOLD_HOOK_NAME,
  })

  for (const refusal of result.refused) failures.push({ key: refusal.key, message: refusal.message })
  if (result.applied.length === 0) return []

  writeFileSync(absFile, result.text, 'utf8')
  return result.applied
}

/**
 * Scaffolds the dictionary and moves every scanned string into it. Never
 * throws — a per-string refusal is reported, not raised.
 */
export function setUpProjectI18n(dir: string): I18nSetupReport | { ok: false; message: string } {
  // A project with no dictionary gets one; a project that already has
  // Studio's keeps it and just extracts what is still inline. A dictionary
  // Studio did NOT write is refused rather than guessed at — see
  // `findScaffoldedI18n`.
  const existing = readTranslationCatalog(dir)
  let scaffold
  if (existing) {
    scaffold = findScaffoldedI18n(dir)
    if (!scaffold) {
      return {
        ok: false,
        message: `This project's dictionary (${existing.capability.source}) is not one Studio wrote, so it can't tell which hook a component should read strings from. Move these strings in by hand, or translate the keys that are already there.`,
      }
    }
  } else {
    const scaffolded = scaffoldProjectI18n(dir)
    if (!scaffolded.ok) return scaffolded
    scaffold = scaffolded.scaffold
  }

  const appRootAbs = resolveAppRoot(dir)
  const contextAbs = join(appRootAbs, ...scaffold.contextRel.split('/'))
  const failures: I18nSetupFailure[] = []

  // Scanned AFTER the scaffold but BEFORE any rewrite: the scaffold does not
  // touch the JSX, and the positions must be the ones the panel showed.
  const minted = mintKeys(findHardcodedStrings(dir))

  const byFile = new Map<string, MintedKey[]>()
  for (const item of minted) {
    const bucket = byFile.get(item.file)
    if (bucket) bucket.push(item)
    else byFile.set(item.file, [item])
  }

  const englishByKey = new Map<string, string>()
  for (const item of minted) englishByKey.set(item.key, item.text)

  const landed = new Set<string>()
  let filesChanged = 0
  for (const [relFile, items] of byFile) {
    try {
      const applied = rewriteFile(appRootAbs, relFile, items, contextAbs, failures)
      if (applied.length > 0) filesChanged++
      for (const key of applied) landed.add(key)
    } catch (err) {
      console.error('[studio:i18nSetup]', err)
      failures.push({ key: relFile, message: err instanceof Error ? err.message : String(err) })
    }
  }

  // The dictionary has to exist in the CACHED profile before
  // `writeTranslationEntry` can find it — that write reads the catalogue,
  // which reads the profile.
  reprobeProjectProfile(dir)

  for (const key of landed) {
    const result = writeTranslationEntry(dir, { locale: 'en', key, value: englishByKey.get(key) ?? '' })
    if (!result.ok) failures.push({ key, message: result.message })
  }

  return {
    ok: true,
    source: scaffold.translationsRel,
    locales: SCAFFOLD_LOCALES,
    extracted: landed.size,
    filesChanged,
    failures,
  }
}

export async function tryServeStudioI18nSetup(req: Request, _url: URL, pathname: string): Promise<Response | null> {
  if (pathname !== ROUTE_PATH || req.method !== 'POST') return null

  try {
    const body = await readValidatedBody(req, SetupBodySchema)
    if (!body) return badRequest('Expected { dir? }.')
    const dir = resolveProjectDir(body.dir ?? null)
    if (!isRealpathContained(dir, projectsRootDir())) return new Response('Not found', { status: 404 })
    return jsonResponse(setUpProjectI18n(dir))
  } catch (err) {
    console.error('[studio:i18nSetup]', err)
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
