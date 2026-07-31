import { describe, expect, it } from 'bun:test'
import { classifyStylesheetEditability } from '../classifyStylesheetEditability'

describe('classifyStylesheetEditability', () => {
  it('classifies a plain hand-authored .css file as editable', () => {
    expect(classifyStylesheetEditability('src/styles/App.css')).toEqual({ kind: 'plain-css' })
  })

  it('refuses a .module.css compile with a specific reason', () => {
    const result = classifyStylesheetEditability('src/components/Card.module.css')
    expect(result.kind).toBe('compiled')
    expect(result.kind === 'compiled' && result.reason).toContain('hashed')
  })

  it('refuses a minified build artefact', () => {
    const result = classifyStylesheetEditability('public/assets/app.min.css')
    expect(result.kind).toBe('compiled')
  })

  it('refuses anything inside dist/, build/, .next/, out/, or node_modules/', () => {
    for (const p of [
      'dist/style.css',
      'project/dist/style.css',
      'build/static/css/main.css',
      '.next/static/css/app.css',
      'out/_next/static/css/app.css',
      'node_modules/@acme/ui/dist/style.css',
    ]) {
      expect(classifyStylesheetEditability(p).kind).toBe('compiled')
    }
  })

  it('handles Windows-style backslash paths identically to forward-slash paths', () => {
    expect(classifyStylesheetEditability('src\\components\\Card.module.css').kind).toBe('compiled')
    expect(classifyStylesheetEditability('src\\styles\\App.css').kind).toBe('plain-css')
  })

  it('is case-insensitive for the compiled-path heuristics', () => {
    expect(classifyStylesheetEditability('src/Card.MODULE.CSS').kind).toBe('compiled')
    expect(classifyStylesheetEditability('DIST/style.css').kind).toBe('compiled')
  })
})
