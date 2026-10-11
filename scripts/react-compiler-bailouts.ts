/**
 * `bun run compiler:bailouts [dir…]` — every function the React Compiler skips
 * under `src/` (or the given dirs), grouped by the compiler's reason.
 * The gate for the canvas / ui / inspector subset is
 * `src/__tests__/architecture/react-compiler-bailouts.test.ts`.
 */
import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { compileReport, type CompilerBailout } from './vite/reactCompilerReport'

const ROOT = join(import.meta.dir, '..')
const SKIP_DIRS = new Set(['node_modules', '__tests__', 'generated'])

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(name)) sourceFiles(path, out)
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(path)
    }
  }
  return out
}

const dirs = process.argv.slice(2)
const files = (dirs.length > 0 ? dirs : ['src']).flatMap((dir) => sourceFiles(join(ROOT, dir)))
const rows: (CompilerBailout & { file: string })[] = []
let compiled = 0
for (const file of files) {
  const report = compileReport(file)
  compiled += report.compiled.length
  const rel = relative(ROOT, file).split(sep).join('/')
  // One function can report several errors; list each (function, reason) once.
  const seen = new Set<string>()
  for (const bailout of report.bailouts) {
    const key = `${bailout.line} ${bailout.reason}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({ ...bailout, file: rel })
  }
}

const skippedFunctions = new Set(rows.map((row) => `${row.file}:${row.line}`)).size
const byReason = new Map<string, typeof rows>()
for (const row of rows) byReason.set(row.reason, [...(byReason.get(row.reason) ?? []), row])
console.log(`${compiled} functions compiled; ${skippedFunctions} skipped in ${new Set(rows.map((r) => r.file)).size} files\n`)
for (const [reason, group] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${group.length}x ${reason}`)
  for (const row of group) console.log(`    ${row.file}:${row.line} ${row.fn}`)
}
