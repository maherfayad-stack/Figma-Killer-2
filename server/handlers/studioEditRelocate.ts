/**
 * studioEditRelocate — re-find an edit's target after its file changed on disk
 * since the board read it (P1-D, WB-1's re-locate half).
 *
 * P1-A's guard made a stale `line:col` refuse instead of writing to the
 * neighbour that slid into the line (`studioEditIdentity.ts`). That is safe,
 * but it turns every edit made after an outside change — VS Code, `git pull`,
 * the agent's own Edit tool — into a refusal and a round trip. The element is
 * usually still there, a few lines away. This finds it, and is allowed to
 * answer only when there is exactly one honest answer:
 *
 *   1. **The text the board read.** `sourceTextHistory.ts` keeps the last few
 *      texts of each file a parse read. The one the board holds is picked by
 *      the edit's own expectation: a remembered text is a candidate only when
 *      the expected element is at the id's position in it. Several may
 *      qualify (a change far below the element leaves its line alone in two
 *      versions); each is used.
 *   2. **Where the line went.** `sourceLineMap.ts` diffs each candidate text
 *      against the file now and maps the line through the diff, under every
 *      optimal reading of that diff. A reading in which the line was deleted
 *      ends the search.
 *   3. **Who is there now.** Each proposed position is re-read with
 *      `readSourceFingerprintAt`, the same identity check the guard makes.
 *
 * Exactly ONE position must hold the expected element. None — the element was
 * rewritten, or deleted — and two — the diff cannot say which of two identical
 * elements it is — both answer `null`, and the edit refuses `element-moved`
 * exactly as before. A guess is how the wrong element got written in the first
 * place.
 */
import { basename } from 'node:path'
import { Project, type SourceFile } from 'ts-morph'
import { readSourceFingerprintAt } from '@core/ast-codemods'
import { mapPositionThroughLineDiff, type MappedPosition } from './sourceLineMap'
import { rememberedSourceTexts } from './studio/sourceTextHistory'

/** The identity at `line:col` of `text` — the same reader the guard uses, over a text that is no longer on disk. */
function fingerprintInText(project: Project, absFile: string, text: string, line: number, col: number): string | undefined {
  const sourceFile = project.createSourceFile(`/remembered/${basename(absFile)}`, text, { overwrite: true })
  return readSourceFingerprintAt(sourceFile, line, col)
}

/**
 * Where the element the board read at `line:col` of `absFile` is in `current`
 * (the file as it is on disk now), or `null` when there is not exactly one
 * honest answer — see this module's doc.
 */
export function relocateSourcePosition(
  absFile: string,
  current: SourceFile,
  line: number,
  col: number,
  expected: string,
): MappedPosition | null {
  const currentText = current.getFullText().replace(/\r\n/g, '\n')
  const scratch = new Project({ useInMemoryFileSystem: true })
  const readTexts = rememberedSourceTexts(absFile).filter(
    (text) => text !== currentText && fingerprintInText(scratch, absFile, text, line, col) === expected,
  )
  if (readTexts.length === 0) return null

  const proposed = new Map<string, MappedPosition>()
  for (const text of readTexts) {
    const positions = mapPositionThroughLineDiff(text, currentText, line, col)
    if (!positions) return null
    for (const position of positions) proposed.set(`${position.line}:${position.col}`, position)
  }
  const verified = [...proposed.values()].filter(
    (position) => readSourceFingerprintAt(current, position.line, position.col) === expected,
  )
  return verified.length === 1 ? verified[0]! : null
}
