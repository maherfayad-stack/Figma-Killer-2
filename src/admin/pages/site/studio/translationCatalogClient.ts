/**
 * translationCatalogClient — the browser half of
 * `GET/POST /admin/api/studio/translations`
 * (`server/handlers/studio/translations.ts`): the project's OWN locale
 * dictionary as a flat `key -> { en, ar }` table.
 *
 * Unlike `componentCatalog.ts`/`iconCatalog.ts` this is deliberately NOT
 * cached per project. Those two describe the project's SHAPE, which only
 * changes on an install or a file move; this one is the thing the panel
 * edits, so a cache would mean the table disagreeing with the file the user
 * just wrote to. Every read is fresh, and every successful write is followed
 * by one.
 */
import { apiRequest } from '@core/http'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { studioWriteDir } from './studioSaveRequests'

export const TranslationEntrySchema = Type.Object({
  key: Type.String(),
  /** Locale key -> value. A locale absent from this record has no translation for the key yet. */
  values: Type.Record(Type.String(), Type.String()),
})
export type TranslationEntry = Static<typeof TranslationEntrySchema>

export const TranslationCatalogSchema = Type.Object({
  capability: Type.Object({
    keys: Type.Array(Type.String()),
    defaultKey: Type.Optional(Type.String()),
    /** Repo-relative path of the dictionary file or `locales/` directory the entries came from. */
    source: Type.String(),
  }),
  perLocaleFiles: Type.Boolean(),
  entries: Type.Array(TranslationEntrySchema),
})
export type TranslationCatalog = Static<typeof TranslationCatalogSchema>

/** One copy-shaped string literal still written inline in the JSX, with the location an extraction would rewrite. */
export const HardcodedStringSchema = Type.Object({
  file: Type.String(),
  line: Type.Number(),
  col: Type.Number(),
  /** The prop it is the value of, or `null` for a JSX text child. */
  prop: Type.Union([Type.String(), Type.Null()]),
  text: Type.String(),
})
export type HardcodedString = Static<typeof HardcodedStringSchema>

const CatalogResponseSchema = Type.Object({
  /** `null` when the project declares no locales at all — a different fact from an empty `entries`. */
  catalog: Type.Union([TranslationCatalogSchema, Type.Null()]),
  hardcoded: Type.Array(HardcodedStringSchema),
})

export interface ContentSnapshot {
  catalog: TranslationCatalog | null
  hardcoded: HardcodedString[]
}

const WriteResponseSchema = Type.Union([
  Type.Object({ ok: Type.Literal(true) }),
  Type.Object({ ok: Type.Literal(false), message: Type.String() }),
])

export async function fetchContentSnapshot(): Promise<ContentSnapshot> {
  const res = await apiRequest('/admin/api/studio/translations', {
    query: { dir: studioWriteDir() ?? undefined },
    schema: CatalogResponseSchema,
  })
  return { catalog: res.catalog, hardcoded: res.hardcoded }
}

/** Writes one `(locale, key)` into the project's dictionary. A structured refusal arrives as `{ ok: false, message }`, not a throw. */
export async function writeTranslation(entry: {
  locale: string
  key: string
  value: string
}): Promise<Static<typeof WriteResponseSchema>> {
  return apiRequest('/admin/api/studio/translations', {
    method: 'POST',
    body: { dir: studioWriteDir() ?? undefined, ...entry },
    schema: WriteResponseSchema,
  })
}

const TranslateResponseSchema = Type.Object({
  ok: Type.Literal(true),
  translated: Type.Number(),
  /** Keys the model left out of its reply — reported, never silently dropped. */
  skipped: Type.Array(Type.String()),
  /** Per-key write refusals (a value that is code, a locale the project does not declare). */
  failures: Type.Array(Type.Object({ key: Type.String(), message: Type.String() })),
  /** Still untranslated because the batch was capped — call again to continue. */
  remaining: Type.Number(),
})
export type TranslateResult = Static<typeof TranslateResponseSchema>

/**
 * Fills in every missing translation for `targetLocale` in one model call,
 * writing each result into the project's dictionary. Omitting `keys` means
 * "what is missing" and never overwrites text somebody already wrote.
 */
export async function translateMissing(params: {
  targetLocale: string
  sourceLocale?: string
  keys?: string[]
}): Promise<TranslateResult> {
  return apiRequest('/admin/api/ai/translate-content', {
    method: 'POST',
    body: { dir: studioWriteDir() ?? undefined, ...params },
    schema: TranslateResponseSchema,
  })
}

const SetupResponseSchema = Type.Union([
  Type.Object({
    ok: Type.Literal(true),
    /** Repo-relative path of the dictionary that now exists. */
    source: Type.String(),
    locales: Type.Array(Type.String()),
    extracted: Type.Number(),
    filesChanged: Type.Number(),
    /** Per-string refusals — a literal outside a component, a file that already binds `t`. */
    failures: Type.Array(Type.Object({ key: Type.String(), message: Type.String() })),
  }),
  Type.Object({ ok: Type.Literal(false), message: Type.String() }),
])
export type I18nSetupResult = Static<typeof SetupResponseSchema>

/**
 * Creates the project's `i18n/` module and moves every hardcoded string into
 * it. Structural: it rewrites the user's JSX. A refusal (the project already
 * has a dictionary) arrives as `{ ok: false, message }`, not a throw.
 */
export async function setUpProjectLocales(): Promise<I18nSetupResult> {
  return apiRequest('/admin/api/studio/i18n-setup', {
    method: 'POST',
    body: { dir: studioWriteDir() ?? undefined },
    schema: SetupResponseSchema,
  })
}
