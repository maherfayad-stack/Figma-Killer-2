/**
 * translationReply — reads a model's answer to "translate this JSON object"
 * into `key -> translation`, tolerantly.
 *
 * The first version of this was a single `safeParseJson(raw, Record<string,
 * string>)`, and it failed on a real 27-key batch. That strictness was the
 * wrong tool: a schema check is the right way to police an API's response,
 * where a deviation means a bug, but a language model's output formatting is
 * not an API contract — it is the one part of the answer that is expected to
 * vary. Refusing an otherwise perfect set of translations because the model
 * wrapped it in a sentence throws away work the user already paid for.
 *
 * So the deviations that are purely presentational are absorbed, and only the
 * ones that would change what gets WRITTEN are refused:
 *
 *   1. **Prose around the object** — the first balanced `{…}` is extracted.
 *   2. **A code fence**, with or without a language tag.
 *   3. **A wrapper key** (`{"translations": {…}}`) — unwrapped only when the
 *      top level has exactly one key, that key is not one of ours, and its
 *      value is an object. All three conditions, so a real single-key batch is
 *      never mistaken for a wrapper.
 *   4. **Nesting.** This is the one that actually bit: keys here are dotted
 *      (`home.searchFlights`), and a model handed thirty of them very
 *      reasonably replies with the nested object they describe. Flattening
 *      back to dotted keys is a lossless rewrite of the same answer.
 *
 * What is NOT absorbed: a non-string leaf is dropped rather than coerced
 * (an object or a number where a translation belongs is not a translation),
 * and a key nobody asked for is dropped rather than written (a hallucinated
 * key must not become a dictionary entry). Both are reported, so a caller can
 * say what happened instead of silently writing less than it claims.
 *
 * It sits beside `oneShot.ts` rather than in `handlers/` on purpose: it routes
 * nothing and authorises nothing, and `server/ai/handlers/` is gated on every
 * file in it calling `requireCapability` — a rule this file would have to
 * break to satisfy.
 */

/** What a model's reply yielded, and what had to be thrown away to get there. */
export interface TranslationReply {
  /** Translations for keys that were actually requested. */
  translations: Record<string, string>
  /** Keys the model returned that were not in the batch — dropped, never written. */
  unexpected: string[]
}

/**
 * The first balanced `{…}` span in `text`, or `undefined`. String-aware, so a
 * brace inside a translated string does not end the object early — which is
 * not hypothetical for UI copy (`"{count} نتائج"`).
 */
function firstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined

  let depth = 0
  let quoted = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '\\') i++
      else if (ch === '"') quoted = false
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

/** Strips a ``` fence if the model added one despite being asked not to. */
function stripCodeFence(text: string): string {
  const fenced = /^\s*```(?:[a-zA-Z]+)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(text)
  return fenced ? fenced[1]! : text
}

/** Flattens nested objects to dotted keys, keeping only string leaves. */
function flatten(value: Record<string, unknown>, prefix: string, out: Map<string, string>): void {
  for (const [name, child] of Object.entries(value)) {
    const key = prefix ? `${prefix}.${name}` : name
    if (typeof child === 'string') {
      out.set(key, child)
      continue
    }
    if (typeof child === 'object' && child !== null && !Array.isArray(child)) {
      flatten(child as Record<string, unknown>, key, out)
    }
    // Anything else (a number, an array, null) is not a translation — dropped.
  }
}

/** Unwraps `{"translations": {…}}` — see this module's doc for why all three conditions are required. */
function unwrap(object: Record<string, unknown>, wanted: ReadonlySet<string>): Record<string, unknown> {
  const names = Object.keys(object)
  if (names.length !== 1) return object
  const only = names[0]!
  if (wanted.has(only)) return object
  const inner = object[only]
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) return object
  return inner as Record<string, unknown>
}

/**
 * Reads a model reply into the translations it actually contains, or
 * `undefined` when there is no JSON object in it at all — the one case that
 * is genuinely unusable rather than merely untidy.
 *
 * `wantedKeys` is both the filter and the disambiguator: it decides which
 * returned keys are real, and it is what makes the wrapper-unwrapping safe.
 */
export function parseTranslationReply(raw: string, wantedKeys: readonly string[]): TranslationReply | undefined {
  const candidate = firstJsonObject(stripCodeFence(raw))
  if (!candidate) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined

  const wanted = new Set(wantedKeys)
  const flat = new Map<string, string>()
  flatten(unwrap(parsed as Record<string, unknown>, wanted), '', flat)

  const translations: Record<string, string> = {}
  const unexpected: string[] = []
  for (const [key, value] of flat) {
    if (wanted.has(key)) translations[key] = value
    else unexpected.push(key)
  }
  return { translations, unexpected }
}
