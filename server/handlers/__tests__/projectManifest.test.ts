/**
 * readProjectManifest - the project's own package.json, as the Dependencies
 * panel lists it. The rejections matter most: package names come from a file a
 * cloned repository wrote, and are joined onto a path to test for an install.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readProjectManifest } from '../studio/projectManifest'

describe('readProjectManifest', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-manifest-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function install(name: string): void {
    fs.mkdirSync(path.join(tmpDir, 'node_modules', name), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'node_modules', name, 'package.json'), '{}')
  }

  it('lists dependencies and devDependencies and which of them are installed', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' }, devDependencies: { vite: '^7.0.0', '@types/react': '^19' } }),
    )
    install('react')
    install('@types/react')
    expect(readProjectManifest(tmpDir)).toEqual({
      dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
      devDependencies: { vite: '^7.0.0', '@types/react': '^19' },
      installedPackages: ['react', '@types/react'],
    })
  })

  it('is empty for a missing or malformed package.json instead of throwing', () => {
    expect(readProjectManifest(tmpDir)).toEqual({ dependencies: {}, devDependencies: {}, installedPackages: [] })
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{ not json')
    expect(readProjectManifest(tmpDir)).toEqual({ dependencies: {}, devDependencies: {}, installedPackages: [] })
  })

  it('ignores non-string ranges and non-object sections', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ dependencies: { react: 19, ok: '1.0.0' }, devDependencies: ['vite'] }))
    expect(readProjectManifest(tmpDir).dependencies).toEqual({ ok: '1.0.0' })
    expect(readProjectManifest(tmpDir).devDependencies).toEqual({})
  })

  it('never probes a path outside node_modules for a hostile package name', () => {
    // A package literally named "../outside" would resolve to <tmp>/outside/package.json.
    fs.mkdirSync(path.join(tmpDir, 'outside'))
    fs.writeFileSync(path.join(tmpDir, 'outside', 'package.json'), '{}')
    fs.mkdirSync(path.join(tmpDir, 'node_modules'))
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { '../outside': '1.0.0', '..\\outside': '1.0.0', '/abs': '1', '@scope/..': '1' } }),
    )
    const manifest = readProjectManifest(tmpDir)
    expect(Object.keys(manifest.dependencies)).toContain('../outside')
    expect(manifest.installedPackages).toEqual([])
  })
})
