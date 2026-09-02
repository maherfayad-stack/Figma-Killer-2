/**
 * cappedFileRead — the byte-capped `read a file we do not control` primitive
 * every project-inspection module in this folder needs.
 *
 * `projectProbe.ts`, `packageManifest.ts` and `componentPackageDetect.ts` all
 * read files out of a user's workspace (`package.json`, a `.d.ts`, a bundled
 * `dist/index.js`) that can be arbitrarily large and arbitrarily malformed.
 * Each of them had grown its own byte-identical copy of these two helpers;
 * this is the one copy, extracted as a dependency-free leaf so none of those
 * three has to import either of the others.
 *
 * Both functions degrade to `undefined` and never throw — a missing file, a
 * directory where a file was expected, an over-cap file, unreadable bytes and
 * a schema mismatch are all "we could not learn anything here", which is
 * exactly what every caller's own contract already says it does.
 *
 * `styleCompileFileRead.ts`'s `readCappedFile` is deliberately NOT folded in:
 * it is the stylesheet-reading leaf, with a stylesheet-specific fixed cap and
 * the CSS-Modules filename pattern beside it. Same shape, different concern.
 */
import { readFileSync, statSync } from 'node:fs'
import { safeParseJson } from '@core/utils/jsonValidate'
import type { Static, TSchema } from '@core/utils/typeboxHelpers'

/** `undefined` when the path is not a regular file, is larger than `maxBytes`, or cannot be read at all. */
export function readTextCapped(absPath: string, maxBytes: number): string | undefined {
  try {
    const stat = statSync(absPath)
    if (!stat.isFile() || stat.size > maxBytes) return undefined
    return readFileSync(absPath, 'utf8')
  } catch {
    return undefined
  }
}

/** `readTextCapped` + TypeBox validation. `undefined` when the file is unreadable, unparsable, or does not match `schema`. */
export function readJsonFileSafe<T extends TSchema>(absPath: string, schema: T, maxBytes: number): Static<T> | undefined {
  const text = readTextCapped(absPath, maxBytes)
  if (text === undefined) return undefined
  const result = safeParseJson(text, schema)
  return result.ok ? result.value : undefined
}
