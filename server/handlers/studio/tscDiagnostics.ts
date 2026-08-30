/**
 * tscDiagnostics — a pure parser turning `tsc --pretty false`'s plain-text
 * diagnostic stream into structured records. Not a schema/boundary type (no
 * caller ever sends this shape in as untyped input — it is purely an OUTPUT
 * shape this process itself produces), so a plain `interface` is the right
 * tool, matching `qualityAudit.ts`'s `QualityFinding`.
 *
 * `tsc`'s plain-text format, one diagnostic per HEADER line, e.g.:
 *
 *   src/screens/Home.tsx(12,7): error TS2322: Type 'string' is not assignable to type 'number'.
 *
 * A diagnostic whose message itself spans multiple lines (TypeScript nests
 * "Types of property 'x' are incompatible." detail under the header,
 * indented, with NO `file(line,col):` prefix of its own) continues onto
 * however many indented lines follow, up to the next header line or the end
 * of output. This parser folds those continuation lines back into the
 * owning diagnostic's `message` (joined with a single space) — a model reads
 * a single flat sentence per diagnostic more easily than reconstructing tree
 * indentation from raw text.
 *
 * A "Found N errors." trailer (only some `tsc` versions print one) and any
 * blank line are dropped rather than folded into whatever diagnostic came
 * before them.
 */

export interface TscDiagnostic {
  /** Project-relative POSIX path, exactly as `tsc` printed it (its `cwd` is always the project root — see `typecheck.ts`). */
  file: string
  line: number
  column: number
  severity: 'error' | 'warning'
  /** e.g. "TS2322" — always the bare `TS` + digits code, never re-derived. */
  code: string
  message: string
}

const DIAGNOSTIC_HEADER_RE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/
const SUMMARY_TRAILER_RE = /^Found \d+ errors?\b/

/** Parses `tsc`'s plain-text (`--pretty false`) stdout into diagnostics, in the order `tsc` printed them. Never throws — a line that matches nothing recognizable is silently dropped rather than desyncing the parse. */
export function parseTscDiagnostics(output: string): TscDiagnostic[] {
  const diagnostics: TscDiagnostic[] = []
  let current: TscDiagnostic | undefined

  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const header = DIAGNOSTIC_HEADER_RE.exec(line)
    if (header) {
      const [, file, lineNo, col, severity, code, message] = header
      current = {
        file,
        line: Number(lineNo),
        column: Number(col),
        severity: severity as 'error' | 'warning',
        code,
        message,
      }
      diagnostics.push(current)
      continue
    }

    if (line.trim().length === 0) continue
    if (SUMMARY_TRAILER_RE.test(line.trim())) continue
    if (current) current.message = `${current.message} ${line.trim()}`
    // A non-header, non-blank line with no owning diagnostic yet (e.g. a
    // banner from a misconfigured toolchain) is dropped — `typecheck.ts`'s
    // `tsc-invocation-error` path is what surfaces THAT case to the caller.
  }

  return diagnostics
}
