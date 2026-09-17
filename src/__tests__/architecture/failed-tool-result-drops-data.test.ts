/**
 * Architecture Gate — a FAILED tool result reaches the model as its `error`
 * string and nothing else.
 *
 * ## Why a gate rather than a comment
 *
 * Two mechanisms in this repo deliberately carry their machine-readable
 * payload TWICE — once structured, once serialised into `error`:
 *
 *   - `duplicate-call` (`toolLoopBounds.ts`'s `duplicateCallOutput`) puts
 *     `{ code, toolName, priorResult }` in `data` AND writes the same JSON
 *     into `error`.
 *   - `toolRefusal` (`src/core/ai/toolRefusal.ts`) keeps `code`/`remedy`/
 *     `retryable` as fields AND renders `… [code=… retryable=…]` into `error`.
 *
 * Both are correct only while the premise holds: every consumer that hands a
 * tool result to a model reduces a FAILED one to `output.error` and drops
 * `output.data`. A structured field the model never sees would be decoration;
 * a duplicate the model sees twice is wasted context. `mcp-21` flagged the
 * double-carry as something to re-check, and re-checking it by reading four
 * files is exactly the kind of manual audit that stops happening.
 *
 * So the premise is pinned here. The day a renderer starts carrying `data` on
 * a failure, this fails and names the serialised copy to delete — rather than
 * the repo silently keeping both forever.
 *
 * Source-level, in the same style as
 * `studio-tool-refusals-are-coded.test.ts`: every one of these renderers is a
 * module-private function, and exporting four functions purely to assert on
 * them would be a worse trade than reading the one line each of them commits
 * to.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

/**
 * Every place a tool result is turned into something a model reads. Each
 * entry names the function that does it, so a failure points at the line
 * rather than at the file.
 */
const RENDERERS: readonly { readonly file: string; readonly fn: string }[] = [
  { file: 'server/ai/drivers/anthropic.ts', fn: 'toolOutputToContent' },
  { file: 'server/ai/drivers/http/chatCompletions.ts', fn: 'toolOutputToString' },
  { file: 'server/ai/drivers/responses-shared.ts', fn: 'toolOutputToString' },
  { file: 'server/ai/mcp/server.ts', fn: 'the CallToolResult builder' },
]

/** The one line each renderer commits to: on `!ok`, answer with `error` and nothing else. */
const FAILURE_BRANCH = /if\s*\(!output\.ok\)\s*\{?\s*return[^\n]*output\.error/

describe('a failed tool result is reduced to its error string', () => {
  it.each(RENDERERS.map((r) => [r.file, r.fn] as const))(
    '%s (%s) answers a failed result with output.error and drops output.data',
    (file) => {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8')
      expect(
        FAILURE_BRANCH.test(source),
        `${file} no longer reduces a failed tool result to output.error. If it now carries output.data to the model, `
          + 'DELETE the serialised copy in `duplicateCallOutput` (server/ai/drivers/http/toolLoopBounds.ts) and the '
          + 'rendered `[code=… retryable=…]` suffix in `toolRefusal` (src/core/ai/toolRefusal.ts) — never leave both.',
      ).toBe(true)
    },
  )

  it('duplicateCallOutput still carries the payload in BOTH data and error, because of the above', () => {
    const source = readFileSync(join(REPO_ROOT, 'server/ai/drivers/http/toolLoopBounds.ts'), 'utf8')
    // The serialised copy and the structured one. If the renderers above ever
    // stop dropping `data`, exactly these two lines are the redundancy to
    // remove — this asserts they are still a matched pair.
    expect(source).toContain('JSON.stringify(payload)')
    expect(source).toContain('data: payload')
  })
})
