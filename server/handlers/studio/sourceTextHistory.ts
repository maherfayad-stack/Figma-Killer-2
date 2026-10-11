/**
 * sourceTextHistory — the last few texts of each source file that a parse the
 * board saw was built from, so an edit whose file changed since can be
 * re-found in it (P1-D, WB-1's re-locate half).
 *
 * A node id is a POSITION in the file as the board last read it. When the file
 * changes on disk after that read, `studioEditRelocate.ts` diffs the text the
 * board read against the text on disk now to learn where the line went — and
 * for that it needs the text the board read, which is gone from disk. This
 * module keeps it.
 *
 * ## What gets remembered, and when
 *
 *   - Every file a PARSE read (`pageParseCache.ts`'s `setCachedRouteParse` —
 *     the page itself, the components inlined into it, every file a value was
 *     read out of, a route's layouts). That is exactly the set of files whose
 *     positions end up in node ids and literal origins. A parse-cache HIT
 *     re-reads nothing, and needs nothing: the text it was built from was
 *     remembered when the entry was filled.
 *   - Every file a Studio write batch touched, after it wrote
 *     (`studioWriteback.ts`). A value write does not re-read the board — the
 *     board keeps its ids and learns the new identity from the save response —
 *     so the post-write text IS what the board's ids describe next.
 *
 * Which of a file's remembered texts the board actually holds is not recorded
 * anywhere, and does not need to be: the edit's own expected fingerprint picks
 * it (a text is a candidate only when the expected element is at the id's
 * position in it) — see `studioEditRelocate.ts`.
 *
 * ## Bounds
 *
 * {@link VERSIONS_PER_FILE} texts per file, newest first, and
 * {@link MAX_TOTAL_CHARS} in all, evicting the least recently remembered file
 * first. In memory and process-scoped, like the parse cache it follows: a
 * server restart forgets everything, and an edit then has no history to be
 * re-found through — it refuses `element-moved` exactly as it did before P1-D,
 * and the board's own recovery re-reads and retries.
 *
 * Texts are stored with `\r\n` folded to `\n`, the text every parser and
 * codemod in Studio reads (`EolPreservingFileSystem`), so line numbers and
 * columns mean the same thing here as in a node id.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** How many past texts of one file are kept. A board is rarely more than one or two reads behind; the rest is margin. */
export const VERSIONS_PER_FILE = 4

/** Every remembered text together, in UTF-16 code units — about 32 MB of memory at the cap. */
export const MAX_TOTAL_CHARS = 16_000_000

/** A file larger than this is not remembered: re-finding an element by a line diff of it would cost more than the refusal it saves. */
const MAX_FILE_CHARS = 1_000_000

/** Absolute path → texts, newest first. A `Map` iterates in insertion order, which is the eviction order. */
const history = new Map<string, string[]>()
let totalChars = 0

function charCount(texts: readonly string[]): number {
  let count = 0
  for (const text of texts) count += text.length
  return count
}

function normalise(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function remember(absFile: string, text: string): void {
  if (text.length > MAX_FILE_CHARS) return
  const key = resolve(absFile)
  const versions = history.get(key) ?? []
  if (versions[0] === text) {
    // Already the newest. Refresh its place in the eviction order all the same.
    history.delete(key)
    history.set(key, versions)
    return
  }
  history.delete(key)
  const next = [text, ...versions.filter((version) => version !== text)].slice(0, VERSIONS_PER_FILE)
  totalChars += charCount(next) - charCount(versions)
  history.set(key, next)
  for (const [oldestKey, oldest] of history) {
    if (totalChars <= MAX_TOTAL_CHARS) break
    history.delete(oldestKey)
    totalChars -= charCount(oldest)
  }
}

/**
 * Remember each file's CURRENT text. A file that cannot be read (deleted
 * between the parse and this call) is skipped — there is nothing to re-find
 * an element in.
 */
export function rememberSourceTexts(absFiles: Iterable<string>): void {
  for (const absFile of absFiles) {
    let text: string
    try {
      text = readFileSync(absFile, 'utf8')
    } catch (_err) {
      continue
    }
    remember(absFile, normalise(text))
  }
}

/** The remembered texts of `absFile`, newest first — `\n` line endings. Empty when nothing is remembered. */
export function rememberedSourceTexts(absFile: string): readonly string[] {
  return history.get(resolve(absFile)) ?? []
}

/** Test-only: forget everything, so one test's reads cannot become another's history. */
export function clearSourceTextHistory(): void {
  history.clear()
  totalChars = 0
}
