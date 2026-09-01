/**
 * turnWriteLog — the record of which files a chat turn's `claude` CLI
 * subprocess wrote, natively (`Write`/`Edit`), during THAT turn.
 *
 * ## Why this exists, and why it can't be simpler
 *
 * The agent authors files directly (`claudeCliToolSurface.ts`) — a native
 * `Write`/`Edit` call never touches Studio's own HTTP/MCP surface, so the
 * admin server has no in-process signal that a file changed. mtime polling
 * would tell you WHETHER a file changed since some reference point, but not
 * HOW MANY TIMES — and "written 9 times this turn" (the edit-thrash signal,
 * WS-9 mcp-tooling item 3) is exactly a count a single mtime can't carry.
 *
 * So this is filled by a `PostToolUse` hook (`hooks/recordToolWrite.ts`,
 * wired into the project's generated `.claude/settings.local.json` by
 * `projectGuide.ts`) that runs as its OWN subprocess, spawned by the `claude`
 * CLI itself, once per `Write`/`Edit` call — the one signal that fires
 * exactly as often as the real thing happened, from inside the CLI's own
 * process tree, with no polling and no race against the tool call itself.
 *
 * ## Turn boundary
 *
 * `resetTurnWriteLog` is called by `claudeCli.ts`'s `streamClaudeCli`, once,
 * right before every real turn's subprocess spawns — so by the time THIS
 * turn's Stop hook fires, the log holds only writes from THIS turn, and by
 * the time the NEXT turn's prompt is built (before `streamClaudeCli` runs
 * again), the log still holds exactly what THIS turn wrote — which is
 * precisely what `pageWriteVerification.ts` wants to report in next turn's
 * digest ("what did the model just do, unverified").
 *
 * ## Format
 *
 * A flat JSON array, not JSONL — turns write at most a few dozen files, so
 * there is no streaming-append case to optimize for, and reading a small
 * array back is one `readFileSync` no fancier than every other `.studio/`
 * sidecar in this codebase.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { parseJsonWithFallback } from '@core/utils/jsonValidate'

const TurnWriteEntrySchema = Type.Object({
  /** Workspace-relative, POSIX-separated — the same convention `resolvePageSourceFile` returns. */
  file: Type.String({ minLength: 1 }),
  atMs: Type.Number(),
})
const TurnWriteLogSchema = Type.Array(TurnWriteEntrySchema)
export type TurnWriteEntry = Static<typeof TurnWriteEntrySchema>

/** A single turn writes at most a few dozen files in the observed failure case (58 writes across 4 screens); capped generously above that so a pathological loop can't grow this file unbounded before the Stop hook ever gets a chance to intervene. */
const MAX_ENTRIES = 500

function logFile(dir: string): string {
  return join(dir, '.studio', 'cache', 'turnWrites.json')
}

/** Clears the log for a fresh turn. Never throws — a failure here just means the upcoming turn's write tracking degrades to "nothing recorded", the same as a project with no writes at all. */
export function resetTurnWriteLog(dir: string): void {
  try {
    const file = logFile(dir)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '[]')
  } catch (err) {
    console.error('[turnWriteLog] failed to reset — continuing without turn-write tracking:', err)
  }
}

/** Every file written so far in the current turn (or the last-completed one, once `resetTurnWriteLog` has not yet run for the next). `[]` on any read failure — never throws. */
export function readTurnWriteLog(dir: string): TurnWriteEntry[] {
  try {
    const file = logFile(dir)
    if (!existsSync(file)) return []
    return parseJsonWithFallback(readFileSync(file, 'utf8'), TurnWriteLogSchema, [])
  } catch (err) {
    console.error('[turnWriteLog] failed to read — treating as empty:', err)
    return []
  }
}

/**
 * Records one native `Write`/`Edit` call. `absOrRelFilePath` is whatever the
 * CLI's `tool_input.file_path` carried — normalised to workspace-relative
 * POSIX here so it compares directly against `resolvePageSourceFile`'s own
 * convention. A path that resolves outside `dir` (should never happen — the
 * CLI's own path permission check already confines native tools to `cwd` —
 * but this runs in a separate, hook-spawned process with no reason to trust
 * its own stdin blindly) is silently dropped rather than recorded.
 *
 * Called from `hooks/recordToolWrite.ts` — the ONLY writer into this log.
 * Never throws.
 */
export function appendTurnWrite(dir: string, absOrRelFilePath: string, atMs: number = Date.now()): void {
  try {
    const rel = relative(dir, absOrRelFilePath)
    if (rel.startsWith('..') || rel.split(sep).includes('..')) return
    const normalized = rel.split(sep).join('/')
    if (normalized.length === 0) return

    const entries = readTurnWriteLog(dir)
    entries.push({ file: normalized, atMs })
    const capped = entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries

    const file = logFile(dir)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(capped))
  } catch (err) {
    console.error('[turnWriteLog] failed to record a write — continuing:', err)
  }
}
