/**
 * Shared path-normalization helper for architecture gates.
 *
 * Several gates in this folder walk the filesystem, build a path relative to
 * some root with `path.join` / `path.relative`, and then compare that path
 * against a string literal in an allowlist that is written with forward
 * slashes (e.g. `'admin/pages/site/code-editor/CodeMirrorEditor.tsx'`).
 *
 * On win32, `path.join` and `path.relative` return backslash-separated
 * paths. Compared byte-for-byte against a POSIX literal, that comparison
 * NEVER matches — not even for the file the allowlist is written to permit.
 * That isn't a narrowly-scoped false positive: it means the gate stops
 * enforcing anything on Windows, because every file (including legitimate
 * ones) reads as "not on the allowlist".
 *
 * Fix: normalize any OS-built path through `toPosixPath()` before comparing
 * it to a POSIX literal. Do this at the comparison boundary, not by writing
 * OS-specific literals into the allowlist.
 *
 * This is the same idiom already used by `no-full-site-scan-in-selectors.test.ts`
 * and `module-size-budgets.test.ts` — reuse it instead of adding a fifth
 * ad-hoc `.replace(/\\/g, '/')`.
 */
import { sep } from 'node:path'

export function toPosixPath(p: string): string {
  return p.split(sep).join('/')
}
