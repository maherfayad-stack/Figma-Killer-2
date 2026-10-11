/**
 * sourceWriteHook — the ONE point where the edit engine's bytes reach the
 * user's source, and the one place a caller can see each write before it lands.
 *
 * The writeback (`studioWriteback.ts`'s batch, every AST codemod's `saveSync`
 * through the disk-backed `EolPreservingFileSystem`, and CSS writeback) writes
 * through {@link writeSourceFile}, or {@link createSourceFileExclusive} for a
 * file that must not already exist. On the editor's own `/save` nothing is
 * listening and those are just the atomic writes they look like.
 *
 * An AGENT's edit batch (`studio_apply_edits`) runs inside
 * {@link withSourceWriteHook}. Then every write is shown to the hook FIRST —
 * the agent write gate, the content check (a Tailwind `@plugin` a model adds
 * must never reach a build), the turn checkpoint's pre-image — and a hook that
 * throws stops that write before a byte lands. A check made after the batch
 * would be too late: a running Tailwind build can load a directive in the
 * moment between the write and the rollback.
 *
 * Synchronous on purpose, like the batch it wraps: the hook is set for exactly
 * the span of one synchronous call, so no other request's writes can ever be
 * seen by it. Nesting is refused rather than guessed at.
 */
import { writeFileSync } from 'node:fs'
import { writeFileAtomic } from './atomicFileWrite'

/** Called with the absolute path and the full new text before the write. Throws to refuse it. */
export type SourceWriteHook = (path: string, text: string) => void

let active: SourceWriteHook | null = null

/** Run `run` (synchronous) with every source write it makes shown to `hook` first. */
export function withSourceWriteHook<T>(hook: SourceWriteHook, run: () => T): T {
  if (active) throw new Error('A source write hook is already active; hooks do not nest.')
  active = hook
  try {
    return run()
  } finally {
    active = null
  }
}

/** Replace (or create) a source file in one step, after the active hook, if any, allows it. */
export function writeSourceFile(path: string, text: string): void {
  active?.(path, text)
  writeFileAtomic(path, text)
}

/** Create a NEW source file, failing if the name is taken (`wx`), after the active hook, if any, allows it. */
export function createSourceFileExclusive(path: string, text: string): void {
  active?.(path, text)
  writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' })
}
