/**
 * pageTemplates — the starter files behind every page kind.
 *
 * Three properties matter here. The first two are not about how the templates
 * look at all; the third is, because these templates are read as a pattern.
 *
 * **Canonical by construction.** A scaffolded page that trips a
 * `checkCanonicalJsx` violation is a page Studio cannot fully edit — the whole
 * point of scaffolding one is that it opens editable. The screen starter has
 * been gated on this since WS-13; the three overlay kinds are new source that
 * has to clear the same bar, so the check runs over EVERY kind rather than the
 * one that happened to exist first.
 *
 * **Dependency-free.** Most projects have no design-system package installed,
 * so a template that imported one would be a broken file the moment it landed.
 * The templates take their geometry from the design system; they must not take
 * their code from it.
 *
 * **A 16px spacing floor.** This is the most copied code in any Studio
 * project, so the scale it ships is the scale everything written afterwards
 * continues. See the test itself for why zero and sizes are exempt.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { checkCanonicalJsx, parsePageFile } from '@core/page-parser'
import { PAGE_KINDS, type PageKind } from '@core/studio-board'
import { detectPageTemplateKit, pageNameBase, starterPage, type PageTemplateKit } from '../pageTemplates'
import { createScaffoldedPage } from '../pageScaffold'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-templates-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Writes a kind's starter into `tmpDir/pages` and parses it back the way Studio will. */
function scaffoldAndParse(componentName: string, kind: PageKind, kit: PageTemplateKit = 'plain') {
  const pagesDir = path.join(tmpDir, 'pages')
  fs.mkdirSync(pagesDir, { recursive: true })
  const starter = starterPage(componentName, kind, kit)
  const file = path.join(pagesDir, `${componentName}.tsx`)
  fs.writeFileSync(file, starter.component)
  if (starter.styles !== undefined && starter.stylesFileName !== undefined) {
    fs.writeFileSync(path.join(pagesDir, starter.stylesFileName), starter.styles)
  }
  return { starter, page: parsePageFile(file, tmpDir) }
}

/** The CSS module a kind produces under the plain kit. Every plain kind has one. */
function plainCss(kind: PageKind): string {
  const styles = starterPage('Frame', kind, 'plain').styles
  if (styles === undefined) throw new Error(`plain ${kind} unexpectedly has no stylesheet`)
  return styles
}

/**
 * Every stylesheet these templates can write, across both kits — so a rule
 * about authored CSS is checked on all of it and not just the kit that happens
 * to have the most. Kinds with no stylesheet (the alm dialog) drop out.
 */
function everyStylesheet(): { kind: PageKind; kit: PageTemplateKit; css: string }[] {
  const sheets: { kind: PageKind; kit: PageTemplateKit; css: string }[] = []
  for (const kit of ['plain', 'alm'] as const) {
    for (const preset of PAGE_KINDS) {
      const css = starterPage('Frame', preset.kind, kit).styles
      if (css !== undefined) sheets.push({ kind: preset.kind, kit, css })
    }
  }
  return sheets
}

describe('starterPage', () => {
  for (const preset of PAGE_KINDS) {
    describe(preset.kind, () => {
      it('passes checkCanonicalJsx with zero violations', () => {
        const { page } = scaffoldAndParse('Frame', preset.kind)
        const violations = checkCanonicalJsx({ page }).filter((finding) => finding.tier === 'violation')
        expect(violations).toEqual([])
      })

      it('parses into a real, single-rooted node tree', () => {
        const { page } = scaffoldAndParse('Frame', preset.kind)
        // One `return`, one root — anything else means the template grew a
        // branch and stopped being a still of one state.
        expect(page.rootIds).toHaveLength(1)
        expect(Object.keys(page.nodes).length).toBeGreaterThan(1)
      })

      it('imports nothing but its own co-located CSS module', () => {
        // The plain kit is what a project with no design system gets, and it
        // must not reference a package that project does not have.
        const { starter } = scaffoldAndParse('Frame', preset.kind)
        const imports = [...starter.component.matchAll(/^import .* from '(.+)'$/gm)].map((m) => m[1])
        expect(imports).toEqual([`./${starter.stylesFileName}`])
      })

      it('names the component and its stylesheet after the page', () => {
        const { starter } = scaffoldAndParse('Checkout', preset.kind)
        expect(starter.component).toContain('export default function Checkout()')
        expect(starter.stylesFileName).toBe('Checkout.module.css')
        expect(starter.component).toContain("import styles from './Checkout.module.css'")
      })

      it('names the component after the page under the alm kit too', () => {
        const { starter } = scaffoldAndParse('Checkout', preset.kind, 'alm')
        expect(starter.component).toContain('export default function Checkout()')
      })

      it('styles every element through the CSS module — never an inline style', () => {
        const { starter } = scaffoldAndParse('Frame', preset.kind)
        expect(starter.component).not.toContain('style={{')
        // Every className in the file resolves through `styles`, so the one
        // authored styling mechanism stays one.
        expect(starter.component).not.toMatch(/className="/)
      })
    })
  }

  it('uses the page name as the heading, so a scaffolded frame names itself', () => {
    for (const preset of PAGE_KINDS) {
      expect(starterPage('Checkout', preset.kind).component).toContain('>Checkout<')
    }
  })

  it('draws a scrim on every plain overlay kind and on no screen', () => {
    // The scrim is what makes an overlay an overlay: it is how much of the
    // presenting screen the panel leaves showing.
    expect(plainCss('screen')).not.toContain('.scrim')
    for (const kind of ['popup', 'sheet-small', 'sheet-large'] as const) {
      expect(plainCss(kind)).toContain('.scrim')
    }
  })

  it('anchors a plain overlay to the frame rather than sizing it from the viewport', () => {
    // A viewport-derived height feeds the frame's own grow-to-content
    // measurement — the loop `resolveViewportUnits.ts` exists to break — and
    // the first version of these templates collapsed to content height because
    // of it, stranding every panel at the top of its frame. `inset: 0` against
    // the positioned ancestor `iframeBodyReset.ts` guarantees cannot collapse.
    for (const kind of ['popup', 'sheet-small', 'sheet-large'] as const) {
      const css = plainCss(kind)
      expect(css).toContain('position: absolute')
      expect(css).toContain('inset: 0')
      expect(css).not.toContain('min-height: 100vh')
    }
  })

  it('separates the two plain sheets by how much screen the panel leaves showing', () => {
    const small = plainCss('sheet-small')
    const large = plainCss('sheet-large')
    // Small floats: capped, inset from the bottom, all four corners rounded —
    // the design system's own `small` bounds.
    expect(small).toContain('min-height: 200px')
    expect(small).toContain('max-height: 50vh')
    expect(small).toContain('border-radius: 34px;')
    // Big is a screen you are inside: below a 54px strip of the presenting
    // screen, running to the bottom edge, top corners only.
    expect(large).toContain('margin-top: 54px')
    expect(large).toContain('border-radius: 34px 34px 0 0')
    expect(large).not.toContain('max-height: 50vh')
  })

  it('gives every plain sheet a leading close button', () => {
    // The way out of a sheet is where the thumb already is. The alm kit gets
    // this from `onClose`; the plain kit has to draw it.
    for (const kind of ['sheet-small', 'sheet-large'] as const) {
      expect(starterPage('Frame', kind, 'plain').component).toContain('aria-label="Close"')
      expect(plainCss(kind)).toContain('.close')
    }
  })

  /**
   * The regression that produced sheets with no panel background, no scrim and
   * no grabber: Studio parses a project's CSS through happy-dom's CSSOM, which
   * DROPS `Canvas`/`CanvasText`, `color-mix()` and slash-alpha `rgb(0 0 0 /
   * .2)` — silently, with no error anywhere. Every colour these templates ship
   * has to round-trip through that parser or it is not a style, it is a
   * comment.
   */
  it('writes only colour syntax Studio\'s CSSOM can parse', () => {
    const banned: [RegExp, string][] = [
      [/\bcolor-mix\s*\(/, 'color-mix() is dropped'],
      [/\brgba?\([^)]*\//, 'slash-alpha rgb()/rgba() is dropped — use rgba(r, g, b, a)'],
      [/:\s*Canvas(Text)?\b/, 'CSS system colours are dropped — use a custom property with a prefers-color-scheme override'],
    ]
    for (const preset of PAGE_KINDS) {
      // Declarations only — these templates NAME the banned syntax in their
      // comments precisely so the next author does not reach for it.
      const css = plainCss(preset.kind).replace(/\/\*[\s\S]*?\*\//g, '')
      for (const [pattern, why] of banned) {
        expect(`${preset.kind}: ${pattern.test(css) ? why : 'ok'}`).toBe(`${preset.kind}: ok`)
      }
    }
  })

  it('adapts the plain panel to dark mode through the syntax that survives', () => {
    for (const kind of ['popup', 'sheet-small', 'sheet-large'] as const) {
      const css = plainCss(kind)
      expect(css).toContain('--panel-surface')
      expect(css).toContain('@media (prefers-color-scheme: dark)')
    }
  })

  /**
   * The 16px spacing floor.
   *
   * These templates are the most copied code in any Studio project — an agent
   * asked for a new screen reads an existing page and continues whatever scale
   * it finds. A starter carrying 5px, 8px and 10px alongside 16px and 24px
   * teaches a scale with no floor, so every value here is 16px or more, and
   * zero stays zero (a reset is the absence of spacing, not a small amount).
   *
   * Sizes are deliberately NOT covered: the 36x5 grabber, the 44px toolbar and
   * the 300px dialog are quoted design-system geometry, not a scale.
   *
   * Runs over BOTH kits — the alm sheet ships a stylesheet too. A `var(--…)`
   * value carries no length for this to read, so the alm sheet's
   * `padding: var(--space)` passes without being checked; the gate's job is to
   * catch a literal below the floor, which is the only way one gets written.
   */
  it('never ships a margin, padding or gap smaller than 16px', () => {
    const SPACING_PROPERTY = /^(margin|padding)(-(top|right|bottom|left|inline|block))?(-(start|end))?$|^(row-|column-)?gap$/
    const LENGTH = /(-?\d*\.?\d+)(px|r?em)\b/g
    for (const { kind, kit, css: authored } of everyStylesheet()) {
      // Comments first: they quote the very numbers this rule rules out.
      const css = authored.replace(/\/\*[\s\S]*?\*\//g, '')
      const undersized: string[] = []
      for (const declaration of css.split(';')) {
        const [rawProperty, ...rest] = declaration.split(':')
        const property = rawProperty!.trim().split(/\s/).pop() ?? ''
        if (!SPACING_PROPERTY.test(property)) continue
        const value = rest.join(':')
        for (const [, amount, unit] of value.matchAll(LENGTH)) {
          const px = unit === 'px' ? Number(amount) : Number(amount) * 16
          // Zero is the absence of spacing; negatives are pulls, not spacing.
          if (px > 0 && px < 16) undersized.push(`${property}: ${amount}${unit}`)
        }
      }
      expect(`${kit} ${kind}: ${undersized.join(', ') || 'ok'}`).toBe(`${kit} ${kind}: ok`)
    }
  })
})

describe('the alm kit', () => {
  it('scaffolds the design system\'s own sheet, not a hand-rolled copy', () => {
    const small = starterPage('Frame', 'sheet-small', 'alm')
    expect(small.component).toContain("import { BottomSheet } from '@alm-design/design-system'")
    // `open` MUST be present: `.bottom-sheet` is `opacity: 0` until
    // `.bottom-sheet--open`, so a sheet without it renders invisible.
    expect(small.component).toContain('<BottomSheet open')
    expect(small.component).toContain('size="small"')
    // Big is the package's own `fullscreen`, not `medium` — `medium` is a tall
    // floating card, which is a different object from a screen you are inside.
    expect(starterPage('Frame', 'sheet-large', 'alm').component).toContain('size="fullscreen"')
  })

  it('passes onClose, which is what draws the sheet\'s close button', () => {
    // The package renders the leading glass ✕ only when `onClose` is provided;
    // without it the toolbar's leading slot is an empty div. A no-op is honest
    // for a still frame — there is nothing to close.
    for (const kind of ['sheet-small', 'sheet-large'] as const) {
      expect(starterPage('Frame', kind, 'alm').component).toContain('onClose={() => {}}')
    }
  })

  it('scaffolds the design system\'s own dialog', () => {
    const popup = starterPage('Frame', 'popup', 'alm')
    expect(popup.component).toContain("import { Dialog } from '@alm-design/design-system'")
    // `Dialog` has no `open` — it renders whenever it is mounted.
    expect(popup.component).not.toContain('<Dialog open')
  })

  it('writes no stylesheet for the dialog — it takes its whole shape from props', () => {
    const starter = starterPage('Frame', 'popup', 'alm')
    expect(starter.styles).toBeUndefined()
    expect(starter.stylesFileName).toBeUndefined()
    expect(starter.component).not.toContain('module.css')
  })

  /**
   * `.bottom-sheet__content` is `flex: 1; min-height: 0; overflow-y: auto` and
   * NO padding — the package's own reference passes `{/* sheet content *\/}`
   * straight in, so the content slot belongs to the consumer. A bare `<p>`
   * dropped in therefore renders flush against the panel edge, which is what
   * the first version of this template did on a real board.
   *
   * `var(--space)` and not `16px`: it is the design system's own base step,
   * defined on `:root` by the package's stylesheet, so the sheet follows the
   * package rather than pinning a copy of today's value.
   */
  it('pads the sheet content slot, which is the one thing the package leaves to the caller', () => {
    for (const kind of ['sheet-small', 'sheet-large'] as const) {
      const starter = starterPage('Frame', kind, 'alm')
      expect(starter.stylesFileName).toBe('Frame.module.css')
      expect(starter.styles).toContain('padding: var(--space)')
      // The wrapper is what carries the inset — the blurb alone would pad one
      // paragraph and leave anything added beside it flush to the edge.
      expect(starter.component).toContain('<div className={styles.content}>')
      // Without this, the browser's default `1em` block margin stacks on the
      // padding and the first line sits 32px down instead of 16px.
      expect(starter.styles).toContain('.blurb {\n  margin: 0;\n}')
    }
  })

  /**
   * Packages first, local files after — the order a hand-written React file
   * uses, and the order a scaffolded page will be copied in. The stylesheet
   * import used to be prepended blindly, which was invisible only while no
   * template had an import of its own.
   */
  it('puts the stylesheet import below the package import, not above it', () => {
    const lines = starterPage('Frame', 'sheet-small', 'alm').component.split('\n')
    expect(lines[0]).toBe("import { BottomSheet } from '@alm-design/design-system'")
    expect(lines[1]).toBe("import styles from './Frame.module.css'")
    expect(lines[2]).toBe('')
  })

  it('scaffolds a screen the same way under either kit — a screen IS the shell', () => {
    expect(starterPage('Frame', 'screen', 'alm')).toEqual(starterPage('Frame', 'screen', 'plain'))
  })
})

describe('detectPageTemplateKit', () => {
  function withPackageJson(contents: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-'))
    fs.writeFileSync(path.join(dir, 'package.json'), contents)
    return dir
  }

  it('picks the alm kit for a project that actually depends on the design system', () => {
    const dir = withPackageJson(JSON.stringify({ dependencies: { '@alm-design/design-system': '^1.0.0' } }))
    expect(detectPageTemplateKit(dir)).toBe('alm')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('picks the plain kit for a project without it', () => {
    const dir = withPackageJson(JSON.stringify({ dependencies: { react: '^19.0.0' } }))
    expect(detectPageTemplateKit(dir)).toBe('plain')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('picks the plain kit when there is no package.json at all', () => {
    // A hand-authored folder with nothing but .tsx files in it is a real,
    // supported shape — it must not scaffold an import it cannot resolve.
    expect(detectPageTemplateKit(tmpDir)).toBe('plain')
  })
})

describe('createScaffoldedPage', () => {
  it('auto-names an unnamed page from its kind, not from "Page"', () => {
    // A project full of `Page3`, `Page7` tells nobody which frame is the sheet.
    expect(pageNameBase('screen')).toBe('Page')
    for (const kind of ['screen', 'popup', 'sheet-small', 'sheet-large'] as const) {
      // A fresh project per kind: the two sheets share a name base, so
      // creating both in one project is the NEXT test, not this one.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-kind-'))
      const result = createScaffoldedPage(dir, '', kind)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.title).toBe(pageNameBase(kind))
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('counts a second sheet up from the shared base', () => {
    createScaffoldedPage(tmpDir, '', 'sheet-small')
    const second = createScaffoldedPage(tmpDir, '', 'sheet-large')
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.title).toBe('Sheet2')
  })

  it('writes the kind\'s own starter, not the screen one', () => {
    const result = createScaffoldedPage(tmpDir, 'Confirm', 'popup')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const source = fs.readFileSync(path.join(tmpDir, 'pages', result.relPath), 'utf8')
    expect(source).toContain('styles.dialog')
    expect(source).toContain('styles.scrim')
  })

  it('defaults to a screen when no kind is given, exactly as before', () => {
    const result = createScaffoldedPage(tmpDir, 'Landing')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const source = fs.readFileSync(path.join(tmpDir, 'pages', result.relPath), 'utf8')
    expect(source).toContain('Start editing this page in Studio.')
    expect(source).not.toContain('styles.scrim')
  })

  it('places every kind on the board at a screen-sized frame', () => {
    // An overlay is drawn over the screen presenting it, so its frame is a
    // screen frame. A sheet cropped to its own panel loses the proportion that
    // makes it a sheet.
    createScaffoldedPage(tmpDir, 'Home', 'screen')
    createScaffoldedPage(tmpDir, 'Confirm', 'popup')
    const boards = JSON.parse(fs.readFileSync(path.join(tmpDir, '.studio', 'boards.json'), 'utf8')) as {
      boards: { frames: { pageId: string; width?: number; height?: number }[] }[]
    }
    const frames = boards.boards[0]!.frames
    expect(frames.map((frame) => frame.pageId)).toEqual(['home', 'confirm'])
    // Neither carries a per-kind size override — both inherit the project's.
    expect(frames.every((frame) => frame.width === undefined && frame.height === undefined)).toBe(true)
  })
})
