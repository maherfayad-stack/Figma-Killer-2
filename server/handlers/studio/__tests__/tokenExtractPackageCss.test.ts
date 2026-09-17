/**
 * tokenExtractPackageCss — the design tokens an installed component package
 * ships, read WITHOUT the project importing its stylesheet.
 *
 * THE BUG THIS EXISTS FOR
 * ───────────────────────
 * A freshly scaffolded project declares a design system, installs it, and
 * imports none of its CSS. `styleCompile.ts`'s vendor path only reads
 * stylesheets the project actually imports, so it found nothing — and the
 * Framework panel then said "No design tokens were found in this project's
 * CSS custom properties, Tailwind theme, vendor package CSS, …" while 297
 * custom properties sat in `node_modules/@alm-design/design-system/dist/
 * index.css`. The message named vendor package CSS as checked, and it wasn't.
 *
 * What is gated here is mostly the RESOLUTION ORDER and the containment
 * guard — a `style` field is a package-controlled string, so it must not be
 * able to walk out of the package directory.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { builtinDesignSystemTokenCss, readBuiltinDesignSystemCss, readInstalledPackageCss } from '../tokenExtractPackageCss'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-css-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function writePkg(name: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, 'node_modules', ...name.split('/'), ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
}

describe('readInstalledPackageCss', () => {
  it('finds the conventional dist/index.css with no manifest hint at all', () => {
    writePkg('@acme/ui', {
      'package.json': JSON.stringify({ name: '@acme/ui' }),
      'dist/index.css': ':root { --acme-blue: #0af; }',
    })

    expect(readInstalledPackageCss(root, ['@acme/ui'])).toContain('--acme-blue')
  })

  it('prefers the manifest `style` field over the conventional name', () => {
    writePkg('@acme/ui', {
      'package.json': JSON.stringify({ name: '@acme/ui', style: './themes/main.css' }),
      'themes/main.css': ':root { --from-style-field: 1px; }',
      'dist/index.css': ':root { --from-convention: 2px; }',
    })

    const css = readInstalledPackageCss(root, ['@acme/ui'])
    expect(css).toContain('--from-style-field')
    expect(css).not.toContain('--from-convention')
  })

  it('digs a .css path out of a nested exports map', () => {
    // The real `@alm-design/design-system` shape: no `style` field, the
    // stylesheet reachable only as an `exports` subpath.
    writePkg('@acme/ui', {
      'package.json': JSON.stringify({
        name: '@acme/ui',
        exports: { '.': './dist/index.js', './styles.css': { default: './dist/styles.css' } },
      }),
      'dist/styles.css': ':root { --from-exports: #fff; }',
    })

    expect(readInstalledPackageCss(root, ['@acme/ui'])).toContain('--from-exports')
  })

  it('refuses a `style` field that climbs out of the package', () => {
    // A package-controlled string must not be able to read arbitrary files.
    fs.writeFileSync(path.join(root, 'secret.css'), ':root { --secret: leaked; }')
    writePkg('@acme/ui', {
      'package.json': JSON.stringify({ name: '@acme/ui', style: '../../secret.css' }),
    })

    expect(readInstalledPackageCss(root, ['@acme/ui'])).toBe('')
  })

  it('reads only the packages it was given, never every install', () => {
    // An unrelated dependency must not get to define the design language.
    writePkg('@acme/ui', {
      'package.json': JSON.stringify({ name: '@acme/ui' }),
      'dist/index.css': ':root { --wanted: 1px; }',
    })
    writePkg('some-other-lib', {
      'package.json': JSON.stringify({ name: 'some-other-lib' }),
      'dist/index.css': ':root { --unwanted: 2px; }',
    })

    const css = readInstalledPackageCss(root, ['@acme/ui'])
    expect(css).toContain('--wanted')
    expect(css).not.toContain('--unwanted')
  })

  it('returns empty for a declared but uninstalled package', () => {
    expect(readInstalledPackageCss(root, ['@acme/ui'])).toBe('')
  })

  it('returns empty when the package ships no stylesheet', () => {
    writePkg('@acme/ui', { 'package.json': JSON.stringify({ name: '@acme/ui' }), 'dist/index.js': 'export {}' })

    expect(readInstalledPackageCss(root, ['@acme/ui'])).toBe('')
  })

  it('takes one stylesheet per package, not every css file in it', () => {
    writePkg('@acme/ui', {
      'package.json': JSON.stringify({ name: '@acme/ui' }),
      'dist/index.css': ':root { --first: 1px; }',
      'dist/style.css': ':root { --second: 2px; }',
    })

    const css = readInstalledPackageCss(root, ['@acme/ui'])
    expect(css).toContain('--first')
    expect(css).not.toContain('--second')
  })
})

/**
 * DS-3 — Studio's OWN copy of the built-in design system's compiled
 * stylesheet. This is what makes Colors/Type/Space populate for a DS-backed
 * project with no `node_modules` at all: the tokens are in Studio's vendored
 * `dist/index.css`, which is also the sheet the canvas injects, so the panel
 * and the canvas can never disagree about which tokens exist.
 */
describe('readBuiltinDesignSystemCss / builtinDesignSystemTokenCss', () => {
  function writeBuiltin(css: string): string {
    const builtinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-ds-css-'))
    fs.mkdirSync(path.join(builtinDir, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(builtinDir, 'dist', 'index.css'), css)
    return builtinDir
  }

  it("reads the vendored dist/index.css", () => {
    const builtinDir = writeBuiltin(':root { --color-aqua-100: #0C9AB0; }')
    try {
      expect(readBuiltinDesignSystemCss(builtinDir)).toContain('--color-aqua-100')
    } finally {
      fs.rmSync(builtinDir, { recursive: true, force: true })
    }
  })

  it("returns '' when the vendor folder is not there, rather than throwing", () => {
    expect(readBuiltinDesignSystemCss(path.join(root, 'no-such-vendor'))).toBe('')
  })

  it('contributes nothing for a project that does not carry the design system', () => {
    // The refusal: a project with no `design-system/` folder cannot import
    // these tokens, so naming them would send an agent to `var(--color-…)`
    // values that resolve to nothing in that project's browser.
    expect(builtinDesignSystemTokenCss(root)).toBe('')
  })
})
