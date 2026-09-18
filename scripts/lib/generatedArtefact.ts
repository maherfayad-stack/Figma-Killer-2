/**
 * How a committed, generated artefact is read back for a freshness comparison.
 *
 * Several gates in this repo re-generate an artefact in memory and assert the
 * committed file matches it **byte-for-byte**: `alm-design-system-fresh`,
 * `plugin-bootstrap-fresh`, `studio-runtime-bundle-fresh`, and the `--check`
 * mode of each of their sync scripts. That comparison is the right one — a
 * weaker signal would let real drift through — but it was comparing two
 * different KINDS of thing.
 *
 * The generator always emits `\n`. The committed file, on the other hand,
 * arrives in whatever line endings the checkout chose: `core.autocrlf=true` is
 * the Git-for-Windows default and this repo's `.gitattributes` carried no
 * `text` rule, so on every Windows clone each of those artefacts landed in the
 * working tree with CRLF. The gates then compared CRLF bytes against LF bytes
 * and reported "stale — run `bun run …:sync`" for artefacts that were, in
 * fact, exactly right. Running the sync "fixed" it only until the next
 * checkout, and on the ALM manifest it did active harm (see
 * `readVendorFile`'s own note).
 *
 * A line ending is a checkout representation, not artefact content: git stores
 * every one of these files with LF in the index (`git ls-files --eol` reports
 * `i/lf` for all of them) and hands the worktree whatever the platform asked
 * for. So the honest comparison normalises the checkout's representation away
 * and still compares every other byte exactly.
 *
 * `.gitattributes` now also pins `eol=lf` repo-wide, which stops NEW checkouts
 * from producing CRLF at all. This helper is what keeps the gates green on a
 * worktree that predates that rule — and it is what keeps them honest if
 * someone's tooling reintroduces CRLF later.
 */
import { existsSync, readFileSync } from 'node:fs'

/**
 * The committed artefact at `path`, with CRLF normalised to LF, or `''` when
 * the file does not exist (so a caller can report "missing" and "stale" with
 * the same comparison).
 */
export function readCommittedArtefact(path: string): string {
  if (!existsSync(path)) return ''
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}
