import { describe, expect, it } from 'bun:test'
import { classifyStylesheetEditability } from '../classifyStylesheetEditability'

describe('classifyStylesheetEditability', () => {
  it('classifies a plain hand-authored .css file as editable', () => {
    expect(classifyStylesheetEditability('src/styles/App.css')).toEqual({ kind: 'plain-css' })
  })

  it('treats a .module.css as editable source, not a build artefact', () => {
    // The class NAME the canvas shows is compiled; the FILE is hand-authored.
    // `studioCss.ts`'s `cssModuleSource` maps the hashed name back to the
    // local one, so callers reach here with the selector as written in the
    // file. Answering 'compiled' here made the `.module.css` that
    // `studio_create_page` scaffolds unwritable by its own author.
    expect(classifyStylesheetEditability('src/components/Card.module.css')).toEqual({ kind: 'plain-css' })
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
    expect(classifyStylesheetEditability('src\\components\\dist\\style.css').kind).toBe('compiled')
    expect(classifyStylesheetEditability('src\\styles\\App.css').kind).toBe('plain-css')
  })

  it('is case-insensitive for the compiled-path heuristics', () => {
    expect(classifyStylesheetEditability('public/App.MIN.CSS').kind).toBe('compiled')
    expect(classifyStylesheetEditability('DIST/style.css').kind).toBe('compiled')
  })
})
