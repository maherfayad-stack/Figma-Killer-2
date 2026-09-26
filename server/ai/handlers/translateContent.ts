/**
 * translateContent — `POST /admin/api/ai/translate-content`, the Content
 * panel's "Translate missing with AI" action.
 *
 * Lives here rather than beside the other `/admin/api/studio/*` translation
 * routes for one structural reason: the studio sub-routers are handed
 * `(req, url, pathname)` and have no `db`, while an AI call needs the
 * authenticated user, their `ai.chat` capability and the admin-configured
 * default credential — all of which the AI handler dispatch already carries.
 * It reads and writes through `translationCatalog`/`translationWrite` exactly
 * like the studio route does, so both paths share one definition of what a
 * dictionary is and what may be written into it.
 *
 * ## One call for the whole batch, and why the model is asked for JSON
 *
 * Translating N strings one request at a time is N round trips and N chances
 * to lose the thread; more importantly, a translator that sees the whole
 * screen's copy at once produces consistent terminology (the same button
 * label rendered the same way everywhere), which per-string calls cannot. So
 * the untranslated keys go up as one JSON object and come back as one JSON
 * object, keyed identically.
 *
 * The response is validated against a TypeBox schema before a single write
 * happens. A model that returns prose, invents keys, or drops half the batch
 * fails that check and the whole call is refused — nothing is written from a
 * response we could not fully parse. Keys the model omitted are reported as
 * `skipped` rather than silently dropped.
 *
 * ## Writes go through the same refusal path as a hand edit
 *
 * Each translation is applied with `writeTranslationEntry`, so a key whose
 * value is code, or a locale the project never declared, refuses exactly as
 * it would if the user had typed the text themselves. Those refusals come
 * back per key in `failures` — a partial success is reported as one, never
 * rounded up to "done".
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { isUntranslated } from '@core/i18n'
import { badRequest, jsonResponse, readValidatedBody } from '../../http'
import { requireCapability } from '../../auth/authz'
import type { DbClient } from '../../db/client'
import { resolveProjectDir, rethrowProjectDirRefusal } from '../../handlers/studioProjects'
import { readTranslationCatalog } from '../../handlers/studio/translationCatalog'
import { writeTranslationEntry } from '../../handlers/studio/translationWrite'
import { resolveDriver } from '../drivers'
import { readCredentialForUser, resolveCredentialForDriver } from '../credentials/store'
import type { AiResolvedCredential } from '../drivers/types'
import { getDefault } from '../defaults/store'
import { AiOneShotError, runOneShotCompletion } from '../oneShot'
import { parseTranslationReply, type TranslationReply } from '../translationReply'

const ROUTE_PATH = '/admin/api/ai/translate-content'

/** Ceiling on one batch. A whole screen's copy fits comfortably; a 5,000-key dictionary would blow the context window and is worth doing in passes the user can see. */
const MAX_BATCH = 80

const BodySchema = Type.Object({
  dir: Type.Optional(Type.String()),
  /** Locale to translate INTO. */
  targetLocale: Type.String({ minLength: 1 }),
  /** Locale to translate FROM. Defaults to the dictionary's own default key. */
  sourceLocale: Type.Optional(Type.String({ minLength: 1 })),
  /** Restrict to these keys. Omitted means "every key with no target value yet". */
  keys: Type.Optional(Type.Array(Type.String())),
})

/** The rules the model works under. Sent as part of the message, not as a system prompt — see `oneShot.ts`. */
function instructionsFor(targetLocale: string, sourceLocale: string): string {
  return [
    `You translate UI copy for a software product from ${sourceLocale} to ${targetLocale}.`,
    '',
    'Rules:',
    `- Reply with ONE JSON object and nothing else: no prose, no code fence, no explanation.`,
    '- The object is FLAT. A key containing dots is one single key, spelled exactly as given —',
    '  `{"home.searchFlights": "…"}`, never `{"home": {"searchFlights": "…"}}`.',
    '- Every key in the input object must appear in your output object, with the same spelling.',
    '- The value for each key is that string translated, and nothing else.',
    '- Preserve any placeholder token exactly as written ({name}, {{count}}, %s, :id).',
    '- Preserve leading/trailing whitespace and terminal punctuation.',
    '- This is interface copy: keep it short, natural and action-first. Do not add politeness the source does not have.',
    '- A string that should not be translated (a brand name, a product code) comes back unchanged.',
    '',
    `Translate every value in the JSON object below into ${targetLocale}:`,
  ].join('\n')
}

/**
 * Which entries this run will translate.
 *
 * Two rules, and the second one is the one that matters: with NO explicit key
 * list this is "fill in what is missing", so an entry that already has a
 * target value is left alone — a bulk action must never overwrite Arabic
 * somebody wrote by hand. Passing `keys` is the explicit opt-in to
 * retranslate, so those entries are included whether or not they already have
 * a value.
 *
 * An entry with nothing to translate FROM (no source text) is skipped in both
 * modes; there is no input for the model.
 *
 * Exported for its own test — it is the part of this route most easily got
 * wrong, and the damage from getting it wrong (silently overwriting reviewed
 * copy) is invisible until someone reads the diff.
 */
export function selectPendingEntries(
  entries: readonly { key: string; values: Record<string, string> }[],
  options: { sourceLocale: string; targetLocale: string; keys?: readonly string[] },
): { key: string; values: Record<string, string> }[] {
  const requested = options.keys ? new Set(options.keys) : null
  return entries.filter((entry) => {
    if (requested && !requested.has(entry.key)) return false
    const source = entry.values[options.sourceLocale]
    if (!source || source.trim() === '') return false
    // Explicit keys mean "translate exactly these", so they bypass the check.
    // Otherwise: anything still untranslated, which INCLUDES a target value
    // that is just the source string handed back — see `isUntranslated`.
    return requested ? true : isUntranslated(source, entry.values[options.targetLocale])
  })
}

export function tryHandleAiTranslateContent(req: Request, db: DbClient, url: URL): Promise<Response> | null {
  if (url.pathname !== ROUTE_PATH || req.method !== 'POST') return null
  return handle(req, db)
}

async function handle(req: Request, db: DbClient): Promise<Response> {
  const user = await requireCapability(req, db, 'ai.chat')
  if (user instanceof Response) return user

  const body = await readValidatedBody(req, BodySchema)
  if (!body) return badRequest('Expected { targetLocale, sourceLocale?, keys? }.')

  const dir = resolveProjectDir(body.dir ?? null)

  const catalog = readTranslationCatalog(dir)
  if (!catalog) return jsonResponse({ error: 'This project has no locale dictionary to translate into.' }, { status: 409 })
  if (!catalog.capability.keys.includes(body.targetLocale)) {
    return jsonResponse({ error: `"${body.targetLocale}" is not a locale this project declares.` }, { status: 409 })
  }
  const sourceLocale = body.sourceLocale ?? catalog.capability.defaultKey ?? catalog.capability.keys[0]!
  if (sourceLocale === body.targetLocale) {
    return jsonResponse({ error: 'Source and target locale are the same.' }, { status: 400 })
  }

  const pending = selectPendingEntries(catalog.entries, {
    sourceLocale,
    targetLocale: body.targetLocale,
    keys: body.keys,
  })

  if (pending.length === 0) {
    return jsonResponse({ ok: true, translated: 0, skipped: [], failures: [], remaining: 0 })
  }
  const batch = pending.slice(0, MAX_BATCH)

  const fallback = await getDefault(db)
  if (!fallback) {
    return jsonResponse(
      { error: 'No default AI model is configured. Set one in Settings → AI before translating.' },
      { status: 409 },
    )
  }
  const record = await readCredentialForUser(db, user.id, fallback.credentialId)
  if (!record) return jsonResponse({ error: 'The configured AI credential is no longer accessible.' }, { status: 409 })

  let resolved: AiResolvedCredential
  try {
    resolved = await resolveCredentialForDriver(record)
  } catch (err) {
    rethrowProjectDirRefusal(err)
    return jsonResponse({ error: err instanceof Error ? err.message : 'Credential resolution failed.' }, { status: 409 })
  }

  // Captured as their own `const`s, fixed at THIS narrowed point, rather than
  // read through `record`/`fallback`/`body`/`user` inside `callModel` below —
  // a nested function reading a captured `const` does not inherit the outer
  // scope's control-flow narrowing (TS treats the closure as possibly running
  // at a point where the type could differ, even though it provably cannot
  // here), so `record.providerId` etc. re-widen to include `null`.
  const providerId = record.providerId
  const modelId = fallback.modelId
  const targetLocale = body.targetLocale
  const userId = user.id
  const userCapabilities = user.capabilities

  /** One model call for `entries`, translated and parsed — or the Response to hand straight back. */
  async function callModel(
    entries: readonly { key: string; values: Record<string, string> }[],
  ): Promise<{ ok: true; reply: TranslationReply } | { ok: false; response: Response }> {
    const source: Record<string, string> = {}
    for (const entry of entries) source[entry.key] = entry.values[sourceLocale]!

    let raw: string
    try {
      raw = await runOneShotCompletion({
        driver: resolveDriver(providerId),
        credentials: resolved,
        modelId,
        instructions: instructionsFor(targetLocale, sourceLocale),
        userMessage: JSON.stringify(source, null, 2),
        signal: req.signal,
        toolContextBase: {
          db,
          userId,
          capabilities: userCapabilities,
          conversationId: 'translate-content',
          snapshot: null,
        },
      })
    } catch (err) {
      rethrowProjectDirRefusal(err)
      console.error('[ai:translateContent]', err)
      // The credential itself was rejected (a Claude CLI setup-token revoked
      // or expired since it was saved) — not a translation problem, and the
      // raw CLI text ("Claude CLI error: Failed to authenticate. API Error:
      // 401 OAuth access token has been revoked.") names a wire protocol
      // nobody asked about. Same reconnect action `Settings → AI →
      // Providers` offers.
      if (err instanceof AiOneShotError && err.authFailure) {
        return {
          ok: false,
          response: jsonResponse(
            { error: 'Claude needs to be reconnected. Open Settings → AI → Providers and sign in again.' },
            { status: 401 },
          ),
        }
      }
      return {
        ok: false,
        response: jsonResponse({ error: err instanceof Error ? err.message : 'The model call failed.' }, { status: 502 }),
      }
    }

    // Presentational deviations in the reply are absorbed; only an answer
    // with no JSON object in it at all — not even a salvageable truncated
    // one — is unusable. See `translationReply.ts`.
    const reply = parseTranslationReply(raw, entries.map((entry) => entry.key))
    if (!reply) {
      console.error('[ai:translateContent] unparsable reply:', raw.slice(0, 400))
      return {
        ok: false,
        response: jsonResponse(
          { error: 'The model replied with no JSON object, so nothing was written. Try again.' },
          { status: 502 },
        ),
      }
    }
    return { ok: true, reply }
  }

  const first = await callModel(batch)
  if (!first.ok) return first.response
  let reply = first.reply

  // A reply cut off mid-object (the driver's own output-token ceiling, for a
  // big batch of long strings) is worth exactly ONE automatic, smaller retry
  // for the keys the cut actually cost — retrying the SAME `MAX_BATCH`-sized
  // request would just get cut at the same spot again, and "click try
  // again" is not a fix a user should have to reach for. A retry that fails
  // outright is not fatal: the first reply's salvaged translations still
  // write below; whatever is still missing reports as `skipped`, same as a
  // model that omitted a key on its own.
  if (reply.truncated) {
    const stillMissing = batch.filter((entry) => reply.translations[entry.key] === undefined)
    if (stillMissing.length > 0) {
      const retried = await callModel(stillMissing)
      if (retried.ok) {
        reply = {
          translations: { ...reply.translations, ...retried.reply.translations },
          unexpected: [...reply.unexpected, ...retried.reply.unexpected],
          truncated: retried.reply.truncated,
        }
      }
    }
  }

  if (Object.keys(reply.translations).length === 0) {
    console.error('[ai:translateContent] no requested keys in reply:', reply.unexpected.join(', ').slice(0, 400))
    return jsonResponse(
      {
        error: `The model returned ${reply.unexpected.length} keys, none of them the ones asked for, so nothing was written.`,
      },
      { status: 502 },
    )
  }

  const failures: { key: string; message: string }[] = []
  const skipped: string[] = []
  let translated = 0
  for (const entry of batch) {
    const value = reply.translations[entry.key]
    if (value === undefined) {
      skipped.push(entry.key)
      continue
    }
    const result = writeTranslationEntry(dir, { locale: body.targetLocale, key: entry.key, value })
    if (result.ok) translated += 1
    else failures.push({ key: entry.key, message: result.message })
  }

  return jsonResponse({
    ok: true,
    translated,
    skipped,
    failures,
    /** Keys still untranslated because the batch was capped — the caller can run again. */
    remaining: pending.length - batch.length,
  } satisfies TranslateContentResponse)
}

export interface TranslateContentResponse {
  ok: true
  translated: number
  skipped: string[]
  failures: { key: string; message: string }[]
  remaining: number
}

export type TranslateContentBody = Static<typeof BodySchema>
