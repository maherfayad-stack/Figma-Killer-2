/**
 * agentRosterDocOutline — the heading+size outline `agentRoster.ts` embeds
 * for a package's own oversized markdown docs, split into its own module for
 * the same reason `agentRosterManifest.ts` was: a distinct reason to change
 * (outline mechanics vs. roster/reference-file DEFINITIONS) and headroom
 * under the 700-line module-size ceiling (`module-size-budgets.test.ts`).
 *
 * ## Why this exists (defect fixed here)
 *
 * `almosafer-ds-expert`'s prompt used to embed the ALM package's `CLAUDE.md`/
 * `design.md` VERBATIM, gated by a 50 KB `readTextCapped` cap. The real
 * published package's files are ~103 KB / ~106 KB — both individually over
 * the cap — so `readTextCapped` silently returned `undefined` and the agent
 * fell into its "nothing to consult" branch on a fully, correctly installed
 * project. Raising the cap would not have fixed the underlying problem: 100+
 * KB of prose regenerated into a subagent prompt on every real chat turn is
 * its own cost, independent of whether it fits under some ceiling.
 *
 * The fix is the same one `studio_read_package_doc`
 * (`server/ai/mcp/tools/studio/packageDocTools.ts`) already ships for exactly
 * this failure mode: embed the OUTLINE (every heading, with its body's byte
 * size) — a few hundred tokens for a 100 KB file — and let the agent pull the
 * one section it actually needs via that tool. This module produces that
 * outline for `agentRoster.ts` to embed.
 *
 * ## Why this doesn't just import `packageDocTools.ts`'s own split logic
 *
 * Two independent reasons, not one convenience call:
 * 1. `server/ai/mcp/tools/studio/` is owned by another agent this round —
 *    editing it (even to export a shared helper) is out of bounds.
 * 2. Even without that constraint, `generateStudioAgentRoster` MUST stay
 *    synchronous — it is called from `claudeCli.ts` un-awaited, on the real
 *    chat turn's critical path, right before the subprocess spawns. That
 *    tool's handler is `async` (every `AiTool` handler is), so calling it
 *    here would either force this generator async (rippling into a caller
 *    this round must not touch) or silently race the spawn against a write
 *    that hasn't landed yet.
 *
 * So this is a small, independent copy of the same splitting logic — same
 * shape (ATX headings, byte-sized bodies), same purpose, deliberately kept
 * out of `agentRoster.ts` itself so a future reader isn't tempted to conflate
 * "the roster's own outline copy" with "the tool's real one".
 */
import { readTextCapped } from './cappedFileRead'

/**
 * Cap for reading a doc SOLELY to build its outline. Generous — far larger
 * than the old 50 KB whole-file-embed cap this replaces — because only
 * headings and byte counts are kept; the body text is discarded immediately
 * after each section is measured and nothing from an oversized file is ever
 * embedded in a prompt.
 */
export const DS_OUTLINE_READ_MAX_BYTES = 2_000_000

export interface DocOutlineSection {
  readonly heading: string
  readonly level: number
  readonly bytes: number
}

export interface DocOutline {
  readonly totalBytes: number
  readonly sections: readonly DocOutlineSection[]
}

/**
 * Heading + byte-size outline of a markdown file. `undefined` when the file
 * is missing, not a regular file, or exceeds {@link DS_OUTLINE_READ_MAX_BYTES}
 * — the same "we could not learn anything here" contract every reader in
 * this folder shares.
 */
export function buildDocOutline(absPath: string): DocOutline | undefined {
  const markdown = readTextCapped(absPath, DS_OUTLINE_READ_MAX_BYTES)
  if (markdown === undefined) return undefined

  const lines = markdown.split('\n')
  const sections: DocOutlineSection[] = []
  let heading = '(intro)'
  let level = 0
  let body: string[] = []

  const flush = (): void => {
    const text = body.join('\n').trim()
    if (heading !== '(intro)' || text.length > 0) {
      sections.push({ heading, level, bytes: Buffer.byteLength(text, 'utf8') })
    }
  }

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line)
    if (match) {
      flush()
      level = match[1]!.length
      heading = match[2]!.trim()
      body = []
      continue
    }
    body.push(line)
  }
  flush()

  return { totalBytes: Buffer.byteLength(markdown, 'utf8'), sections }
}

/** One indented bullet per heading — `## Foo` renders one level deeper than `# Foo`. */
export function renderDocOutline(outline: DocOutline): string {
  return outline.sections
    .map((s) => `${'  '.repeat(Math.max(0, s.level - 1))}- ${s.heading} (${s.bytes.toLocaleString('en-US')} bytes)`)
    .join('\n')
}
