/**
 * tokenWriteTypes - the vocabulary of a token write plan: what a plan is, and
 * the refusals that mean "there is no honest target". Shared by the value
 * planner (`tokenWrite.ts`) and the rename/remove planner (`tokenRefactor.ts`),
 * which `tokenWrite.ts` delegates to, so neither imports the other.
 */
import type { TokenTarget } from '@core/studio-tokens'

export type TokenWriteCode =
  | 'no-such-token'
  | 'read-only-source'
  | 'ambiguous-declaration'
  | 'invalid-input'
  | 'already-declared'
  | 'no-project-stylesheet'
  | 'stale-source'
  /** A token still read somewhere cannot be removed without saying where its readers go. */
  | 'in-use'
  /** A rename that would silently change what the token means (a Tailwind `@theme` name is also a utility class). */
  | 'rename-blocked'

export interface TokenWriteRefusal {
  readonly ok: false
  readonly code: TokenWriteCode
  readonly message: string
  readonly remedy?: string
  readonly details?: { readonly declarations: readonly string[] }
  /** Index into the request's edits - which entry the refusal came from. */
  readonly entryIndex: number
}

/** One file's planned rewrite. `original` is the text the plan was made against. */
export interface PlannedTokenFile {
  readonly file: string
  readonly original: string
  readonly next: string
}

export interface TokenWritePlan {
  readonly ok: true
  readonly files: readonly PlannedTokenFile[]
  readonly changed: ReadonlyArray<{ name: string; target: TokenTarget; file: string; line: number; from: string; to: string }>
  readonly unchanged: ReadonlyArray<{ name: string; target: TokenTarget }>
  readonly inserted: ReadonlyArray<{ name: string; target: TokenTarget; file: string }>
  /** A rename: how many mentions of the old name moved, across how many files. */
  readonly renamed: ReadonlyArray<{ name: string; to: string; mentions: number; files: number }>
  /** A remove: how many declarations went, and how many readers moved to `replacedWith`. */
  readonly removed: ReadonlyArray<{ name: string; declarations: number; movedReaders: number; replacedWith?: string }>
}

export function tokenRefusal(
  entryIndex: number,
  code: TokenWriteCode,
  message: string,
  extra: { remedy?: string; declarations?: readonly string[] } = {},
): TokenWriteRefusal {
  return {
    ok: false,
    code,
    message,
    entryIndex,
    ...(extra.remedy ? { remedy: extra.remedy } : {}),
    ...(extra.declarations ? { details: { declarations: extra.declarations } } : {}),
  }
}
