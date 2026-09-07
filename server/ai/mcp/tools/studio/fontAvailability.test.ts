/**
 * fontAvailability — the `font-not-available` finding.
 *
 * The property that matters is the asymmetry: a family the project genuinely
 * cannot load must be named, and a family it CAN load — through any of the
 * five routes availability can arrive by — must never be. A false positive
 * here tells the agent to rewrite a correct font stack, which is worse than
 * silence; the composition rule that fired ~20 false positives per real hit
 * was rejected outright for exactly that reason (`qualityCheck.ts`'s module
 * doc), and this rule is held to the same bar.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditFontAvailability, collectFontAvailability } from './fontAvailability'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'font-availability-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): string {
  const abs = join(dir, ...relPath.split('/'))
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, contents, 'utf8')
  return abs
}

function sheet(relPath: string, css: string) {
  return { relPath, absPath: write(relPath, css) }
}

/** The audit against a project whose only facts are what the test wrote to disk. */
function audit(sheets: { relPath: string; absPath: string }[], projectCss: string[] = []) {
  return auditFontAvailability(sheets, collectFontAvailability(dir, projectCss))
}

describe('auditFontAvailability — fires', () => {
  it('names a first family the project cannot load anywhere', () => {
    const findings = audit([sheet('src/Home.module.css', '.title { font-family: "Poppins", sans-serif; }')])
    expect(findings).toHaveLength(1)
    expect(findings[0]!.code).toBe('font-not-available')
    expect(findings[0]!.file).toBe('src/Home.module.css')
    expect(findings[0]!.message).toContain('Poppins')
  })

  it('explains the consequence, not just the fact — the fallback family and why sizes tuned from here are wrong', () => {
    const findings = audit([sheet('src/Home.module.css', '.title { font-family: Poppins, Georgia; }')])
    expect(findings[0]!.message).toContain('Georgia')
    expect(findings[0]!.message).toContain('x-height')
    expect(findings[0]!.message).toContain('wrong typeface')
  })

  it('reports the line the declaration is on, so the finding is a file:line', () => {
    const css = ['.a { color: red; }', '', '.title {', '  font-family: Poppins;', '}'].join('\n')
    const findings = audit([sheet('src/Home.module.css', css)])
    expect(findings[0]!.line).toBe(4)
  })

  it('reports each missing family once, not once per rule that uses it', () => {
    const css = ['.a { font-family: Poppins; }', '.b { font-family: Poppins; }', '.c { font-family: Poppins; }'].join('\n')
    const findings = audit([sheet('src/Home.module.css', css)])
    expect(findings).toHaveLength(1)
  })

  it('treats a matching font file on disk as availability — "you have it, the wiring is off" is a quieter problem than "it does not exist"', () => {
    write('public/fonts/Poppins-Regular.woff2', 'not-a-real-font')
    const findings = audit([sheet('src/Home.module.css', '.title { font-family: Poppins, sans-serif; }')])
    // Available via the on-disk route, so no finding at all — the file IS the
    // project having the font. (The message branch that names an unwired file
    // exists for the case where the family and the file disagree.)
    expect(findings).toHaveLength(0)
  })

  it('resolves a token-driven stack before judging it — font-family: var(--font-display)', () => {
    const projectCss = [':root { --font-display: "Clash Display", sans-serif; }']
    const findings = audit([sheet('src/Home.module.css', '.title { font-family: var(--font-display); }')], projectCss)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.message).toContain('Clash Display')
  })
})

describe('auditFontAvailability — stays quiet', () => {
  it('says nothing about a generic or web-safe first family', () => {
    const css = [
      '.a { font-family: sans-serif; }',
      '.b { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }',
      '.c { font-family: "Helvetica Neue", Arial, sans-serif; }',
      '.d { font-family: ui-monospace, Menlo, monospace; }',
    ].join('\n')
    expect(audit([sheet('src/Home.module.css', css)])).toHaveLength(0)
  })

  it('says nothing when the page declares its own @font-face for the family', () => {
    const css = [
      '@font-face { font-family: "Clash Display"; src: url(/fonts/clash.woff2) format("woff2"); }',
      '.title { font-family: "Clash Display", sans-serif; }',
    ].join('\n')
    expect(audit([sheet('src/Home.module.css', css)])).toHaveLength(0)
  })

  it('never judges a @font-face\'s OWN font-family — that declares a family, it does not use one', () => {
    const css = '@font-face { font-family: "Clash Display"; src: url(/fonts/clash.woff2); }'
    expect(audit([sheet('src/fonts.css', css)])).toHaveLength(0)
  })

  it('says nothing when the project\'s compiled/vendor CSS ships the face', () => {
    const projectCss = ['@font-face { font-family: Satoshi; src: url(./satoshi.woff2); }']
    expect(audit([sheet('src/Home.module.css', '.t { font-family: Satoshi, sans-serif; }')], projectCss)).toHaveLength(0)
  })

  it('says nothing when index.html links the family from Google Fonts', () => {
    write('index.html', '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;700&display=swap">')
    expect(audit([sheet('src/Home.module.css', '.t { font-family: "Plus Jakarta Sans", sans-serif; }')])).toHaveLength(0)
  })

  it('says nothing when the legacy Google Fonts URL form names the family', () => {
    write('index.html', '<link href="https://fonts.googleapis.com/css?family=Lora:400|Poppins:700">')
    const css = ['.a { font-family: Lora; }', '.b { font-family: Poppins; }'].join('\n')
    expect(audit([sheet('src/Home.module.css', css)])).toHaveLength(0)
  })

  it('says nothing when next/font/google imports the family', () => {
    write('app/layout.tsx', "import { Inter, Roboto_Mono } from 'next/font/google'\nexport default function L() { return null }")
    const css = ['.a { font-family: Inter; }', '.b { font-family: "Roboto Mono", monospace; }'].join('\n')
    expect(audit([sheet('src/Home.module.css', css)])).toHaveLength(0)
  })

  it('says nothing when a matching font file is on disk under a conventional asset dir', () => {
    write('public/fonts/ClashDisplay-SemiBold.woff2', 'x')
    expect(audit([sheet('src/Home.module.css', '.t { font-family: "Clash Display", sans-serif; }')])).toHaveLength(0)
  })

  it('stands down entirely for a project using next/font/local — a generated family name cannot be judged statically', () => {
    write('app/layout.tsx', "import localFont from 'next/font/local'\nconst f = localFont({ src: './x.woff2' })")
    const availability = collectFontAvailability(dir, [])
    expect(availability.suppressed).toBe(true)
    expect(auditFontAvailability([sheet('src/Home.module.css', '.t { font-family: Poppins; }')], availability)).toHaveLength(0)
  })

  it('says nothing about an unresolvable var() — a token this scan cannot see is not evidence of a missing font', () => {
    expect(audit([sheet('src/Home.module.css', '.t { font-family: var(--font-unknown); }')])).toHaveLength(0)
  })

  it('judges only the FIRST family — a fallback chain naming faces the machine may lack is the point of having one', () => {
    const findings = audit([sheet('src/Home.module.css', '.t { font-family: Arial, Poppins, Satoshi, sans-serif; }')])
    expect(findings).toHaveLength(0)
  })
})

describe('collectFontAvailability', () => {
  it('collects font files on disk as availability AND as evidence', () => {
    write('public/fonts/Inter-Regular.woff2', 'x')
    write('src/assets/Satoshi-Variable.ttf', 'x')
    const availability = collectFontAvailability(dir, [])
    expect(availability.fontFiles).toContain('public/fonts/Inter-Regular.woff2')
    expect(availability.families.has('inter')).toBe(true)
    expect(availability.families.has('satoshi')).toBe(true)
  })

  it('ignores non-font files in the same directories', () => {
    write('public/logo.svg', '<svg/>')
    expect(collectFontAvailability(dir, []).fontFiles).toHaveLength(0)
  })

  it('is not suppressed by default', () => {
    expect(collectFontAvailability(dir, []).suppressed).toBe(false)
  })
})
