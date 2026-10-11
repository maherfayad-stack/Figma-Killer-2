/**
 * tokenWorkspaceFiles - the project's text files that can mention a custom
 * property, read once for the two things that need them: the usage scan the
 * Variables panel counts with, and the rename/remove planner that rewrites the
 * same mentions. One list, so a count and a rewrite can never disagree about
 * which files they looked in.
 *
 * Bounded (file count, file size) and byte-exact: a file that is not valid
 * UTF-8 is skipped rather than read lossily, because a rewrite would write
 * the lossy text back.
 */
import { readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { isPrototypeShellPath, listWorkspaceFiles } from '@core/page-parser'

const TOKEN_FILE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.scss', '.sass', '.less', '.html', '.vue', '.svelte', '.mdx'])
const MAX_FILES = 4000
const MAX_FILE_BYTES = 512 * 1024

export interface TokenWorkspaceFile {
  /** Workspace-relative POSIX path. */
  readonly file: string
  readonly text: string
}

/**
 * Every project file that contains `--` somewhere, with its text. A Tailwind
 * theme rename (CT-6) also needs the files that spell the name as a CLASS
 * (`bg-brand`), which hold no `--` at all: `allText` returns every readable
 * file.
 */
export function readTokenWorkspaceFiles(dir: string, options: { allText?: boolean } = {}): TokenWorkspaceFile[] {
  const files: TokenWorkspaceFile[] = []
  let scanned = 0
  for (const rel of listWorkspaceFiles(dir)) {
    if (scanned >= MAX_FILES) break
    if (!TOKEN_FILE_EXTENSIONS.has(extname(rel).toLowerCase()) || isPrototypeShellPath(rel)) continue
    try {
      const buffer = readFileSync(join(dir, rel))
      if (buffer.byteLength > MAX_FILE_BYTES) continue
      const text = buffer.toString('utf8')
      scanned++
      if ((!options.allText && !text.includes('--')) || !Buffer.from(text, 'utf8').equals(buffer)) continue
      files.push({ file: rel, text })
    } catch (err) {
      console.error('[studio:tokenCatalog] could not read a file for the token scan:', rel, err)
    }
  }
  return files
}
