/**
 * `bun run compiler:bailouts [dir…]` — every function the React Compiler skips
 * under `src/` (or the given dirs), grouped by the compiler's reason.
 * The gate for the canvas / ui / inspector subset is
 * `src/__tests__/architecture/react-compiler-bailouts.test.ts`.
 */
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
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
  compiled += report.compiled
  for (const bailout of report.bailouts) rows.push({ ...bailout, file: relative(ROOT, file).split('\\').join('/') })
}

const byReason = new Map<string, typeof rows>()
for (const row of rows) byReason.set(row.reason, [...(byReason.get(row.reason) ?? []), row])
console.log(`${compiled} functions compiled; ${rows.length} skipped in ${new Set(rows.map((r) => r.file)).size} files\n`)
for (const [reason, group] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${group.length}x ${reason}`)
  for (const row of group) console.log(`    ${row.file}:${row.line} ${row.fn}`)
}
