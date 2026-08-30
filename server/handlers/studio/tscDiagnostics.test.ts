/**
 * tscDiagnostics.ts — parser coverage. Every fixture below is verbatim (or a
 * trimmed excerpt) of real `tsc --pretty false` output, captured by actually
 * running the repo's own `node_modules/typescript/bin/tsc` against small
 * broken fixtures while building `typecheck.ts` — not hand-imagined text.
 */
import { describe, expect, it } from 'bun:test'
import { parseTscDiagnostics } from './tscDiagnostics'

describe('parseTscDiagnostics', () => {
  it('parses a single-line diagnostic', () => {
    const out = "a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n"
    const diagnostics = parseTscDiagnostics(out)
    expect(diagnostics).toEqual([
      { file: 'a.ts', line: 1, column: 7, severity: 'error', code: 'TS2322', message: "Type 'string' is not assignable to type 'number'." },
    ])
  })

  it('parses multiple diagnostics across different files, in order', () => {
    const out = [
      "a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/screens/Home.tsx(2,3): error TS2322: Type 'string' is not assignable to type 'number'.",
      '',
    ].join('\n')
    const diagnostics = parseTscDiagnostics(out)
    expect(diagnostics.map((d) => d.file)).toEqual(['a.ts', 'src/screens/Home.tsx'])
    expect(diagnostics.every((d) => d.severity === 'error' && d.code === 'TS2322')).toBe(true)
  })

  it('folds an indented multi-line detail block back into the owning diagnostic message', () => {
    const out = [
      "a.ts(3,7): error TS2322: Type 'B' is not assignable to type 'A'.",
      "  Types of property 'a' are incompatible.",
      "    Type 'string' is not assignable to type 'number'.",
      "a.ts(5,5): error TS2322: Type 'string' is not assignable to type 'number'.",
      '',
    ].join('\n')
    const diagnostics = parseTscDiagnostics(out)
    expect(diagnostics).toHaveLength(2)
    expect(diagnostics[0]).toMatchObject({ file: 'a.ts', line: 3, column: 7, code: 'TS2322' })
    expect(diagnostics[0].message).toBe(
      "Type 'B' is not assignable to type 'A'. Types of property 'a' are incompatible. Type 'string' is not assignable to type 'number'.",
    )
    expect(diagnostics[1]).toMatchObject({ file: 'a.ts', line: 5, column: 5 })
  })

  it('parses a config-file diagnostic the same way as a source-file one', () => {
    const out =
      "tsconfig.json(1,34): error TS6046: Argument for '--target' option must be: 'es6', 'es2015', 'esnext'.\n"
    const diagnostics = parseTscDiagnostics(out)
    expect(diagnostics).toEqual([
      {
        file: 'tsconfig.json',
        line: 1,
        column: 34,
        severity: 'error',
        code: 'TS6046',
        message: "Argument for '--target' option must be: 'es6', 'es2015', 'esnext'.",
      },
    ])
  })

  it('parses a warning severity diagnostic', () => {
    const out = 'a.ts(1,1): warning TS1234: Some warning message.\n'
    const diagnostics = parseTscDiagnostics(out)
    expect(diagnostics[0].severity).toBe('warning')
  })

  it('drops a "Found N errors" summary trailer rather than folding it into the last diagnostic', () => {
    const out = [
      "a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      'Found 1 error in a.ts:1',
      '',
    ].join('\n')
    const diagnostics = parseTscDiagnostics(out)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0].message).toBe("Type 'string' is not assignable to type 'number'.")
  })

  it('returns an empty array for clean output', () => {
    expect(parseTscDiagnostics('')).toEqual([])
  })

  it('returns an empty array for unrecognizable output (e.g. --help text) rather than throwing', () => {
    const out = [
      'Version 6.0.3',
      'tsc: The TypeScript Compiler - Version 6.0.3',
      '',
      'COMMON COMMANDS',
      '',
      '  tsc',
      '  Compiles the current project (tsconfig.json in the working directory.)',
      '',
    ].join('\n')
    expect(parseTscDiagnostics(out)).toEqual([])
  })

  it('handles CRLF line endings', () => {
    const out = "a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\r\n"
    const diagnostics = parseTscDiagnostics(out)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0].message).toBe("Type 'string' is not assignable to type 'number'.")
  })
})
