/**
 * Test fixture for anything that boots a dev server: a project `package.json`
 * with the given scripts and an installed `vite` package whose bin
 * `viteLaunch.ts` resolves. Studio runs the project's own Vite bin, never the
 * package manager, so a fixture without one never boots — and a fake `spawn`
 * never runs the bin, so an empty file is enough.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function writeViteProject(dir: string, scripts: Record<string, string>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts }))
  const vite = join(dir, 'node_modules', 'vite')
  mkdirSync(join(vite, 'bin'), { recursive: true })
  writeFileSync(join(vite, 'package.json'), JSON.stringify({ name: 'vite', bin: { vite: 'bin/vite.js' } }))
  writeFileSync(join(vite, 'bin', 'vite.js'), '')
}
