/**
 * projectProbe.ts + studioMeta.ts — unit tests for WS-1.2.
 *
 * `probeProject` covers one fixture per detected framework shape, plus a
 * style-toolchain / alias-merge / component-package pass. The "no framework
 * detected" fixture deliberately shares NOTHING with the eSIM corpus other
 * suites in this repo were grown on (see `genericRepoShapes.test.ts`'s doc
 * comment for why that discipline exists): `.jsx` not `.tsx`, arrow
 * components assigned to `const` then exported separately, a `lib/` root
 * instead of `src/`, a barrel file alongside the pages.
 *
 * `readStudioMeta`/`mergeStudioMeta` cover the tolerant-partial-file and
 * degrade-don't-throw contracts `studioMeta.ts`'s module doc calls out as the
 * trap: a meta carrying only `pagesDir` must still resolve, a malformed file
 * must degrade to `{}` rather than throw, and a `pagesDir` escape attempt
 * must be stripped rather than trusted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { probeProject, tryServeStudioProbe } from '../studio/projectProbe'
import { detectLocales } from '../studio/localeProbe'
import type { ProjectProfile } from '../studio/projectProfileSchema'
import { mergeStudioMeta, readStudioMeta, writeStudioMeta } from '../studio/studioMeta'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-probe-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): void {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
}

function writePackageJson(deps: Record<string, string> = {}, devDeps: Record<string, string> = {}): void {
  write('package.json', JSON.stringify({ name: 'fixture', dependencies: deps, devDependencies: devDeps }))
}

// ---------------------------------------------------------------------------
// Framework detection
// ---------------------------------------------------------------------------

describe('probeProject — framework detection', () => {
  it('detects a Next.js App Router project', () => {
    writePackageJson({ next: '^14.0.0', react: '^18.0.0' })
    write('next.config.js', 'module.exports = {}\n')
    write('app/page.tsx', 'export default function Page() { return <div>Home</div> }\n')
    write('app/about/page.tsx', 'export default function About() { return <div>About</div> }\n')

    const profile = probeProject(tmpDir)
    expect(profile.framework).toBe('next-app')
    expect(profile.pagesDir).toBe('app')
    expect(profile.routeStyle).toBe('file-router')
  })

  it('detects a Next.js Pages Router project', () => {
    writePackageJson({ next: '^14.0.0' })
    write('next.config.mjs', 'export default {}\n')
    write('pages/index.tsx', 'export default function Home() { return <div>Home</div> }\n')

    const profile = probeProject(tmpDir)
    expect(profile.framework).toBe('next-pages')
    expect(profile.pagesDir).toBe('pages')
    expect(profile.routeStyle).toBe('file-router')
  })

  it('warns rather than misclassifying when next.config exists with no app/ or pages/ dir', () => {
    writePackageJson({ next: '^14.0.0' })
    write('next.config.js', 'module.exports = {}\n')

    const profile = probeProject(tmpDir)
    expect(profile.framework).toBe('unknown')
    expect(profile.warnings.some((w) => w.code === 'next-config-no-routes-found')).toBe(true)
  })

  it('detects a Vite project and its entry file from index.html', () => {
    writePackageJson({ vite: '^5.0.0', react: '^18.0.0' })
    write('vite.config.ts', 'export default {}\n')
    write('index.html', '<html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n')
    write('src/main.tsx', 'console.log("entry")\n')

    const profile = probeProject(tmpDir)
    expect(profile.framework).toBe('vite')
    expect(profile.entryFiles).toEqual(['src/main.tsx'])
  })

  it('detects a CRA project via the react-scripts dependency', () => {
    writePackageJson({ 'react-scripts': '^5.0.1', react: '^18.0.0' })
    write('src/index.tsx', 'console.log("entry")\n')

    const profile = probeProject(tmpDir)
    expect(profile.framework).toBe('cra')
    expect(profile.entryFiles).toEqual(['src/index.tsx'])
  })

  it('ranks pages-directory candidates by JSX-default-export density on a repo sharing nothing with the eSIM corpus', () => {
    // No framework config, no framework dependency at all.
    writePackageJson({})

    // `lib/screens/` — three arrow components, each a separate default export
    // (named const, exported on its own line — not `export default () =>`).
    write(
      'lib/screens/Home.jsx',
      ["const Home = () => (", '  <main>', '    <h1>Home</h1>', '  </main>', ')', '', 'export default Home', ''].join('\n'),
    )
    write(
      'lib/screens/About.jsx',
      ["const About = () => (", '  <section>About</section>', ')', '', 'export default About', ''].join('\n'),
    )
    write(
      'lib/screens/Contact.jsx',
      ["const Contact = () => (", '  <section>Contact</section>', ')', '', 'export default Contact', ''].join('\n'),
    )
    // A barrel sitting alongside the screens — not itself JSX-returning.
    write('lib/screens/index.js', ["export { default as Home } from './Home'", ''].join('\n'))

    // `lib/components/` — one JSX-returning default export (lower match count).
    write(
      'lib/components/Button.jsx',
      ["const Button = (props) => <button {...props} />", '', 'export default Button', ''].join('\n'),
    )

    // `lib/utils/` — a default export that is NOT JSX. Must be excluded entirely.
    write('lib/utils/format.jsx', ['export default function formatDate(d) {', '  return String(d)', '}', ''].join('\n'))

    const profile = probeProject(tmpDir)
    expect(profile.framework).toBe('unknown')
    expect(profile.pagesDir).toBe('lib/screens')
    expect(profile.routeStyle).toBe('flat')
    expect(profile.warnings.some((w) => w.code === 'pages-dir-heuristic')).toBe(true)
    expect(profile.pagesDirCandidates).toBeDefined()
    const dirs = profile.pagesDirCandidates!.map((c) => c.dir)
    expect(dirs).toContain('lib/screens')
    expect(dirs).not.toContain('lib/utils')
    expect(dirs[0]).toBe('lib/screens')
  })

  it('falls back to the default pages dir with a warning when nothing looks like a page at all', () => {
    writePackageJson({})
    write('lib/utils/format.js', 'export default function formatDate(d) { return String(d) }\n')

    const profile = probeProject(tmpDir)
    expect(profile.pagesDir).toBe('pages')
    expect(profile.warnings.some((w) => w.code === 'pages-dir-not-found')).toBe(true)
  })

  it('prefers a directory whose RECURSIVE subtree holds more matching files over a same-ratio sibling with a higher DIRECT count', () => {
    // No framework config — forces the JSX-density heuristic. Fixture shares
    // nothing with the eSIM corpus (`views`/`widgets`, not `screens`/
    // `components`) — see `genericRepoShapes.test.ts`'s discipline. Mirrors
    // the real shape that made `mcp-01` mis-rank `journey-screens/src/
    // components` over `journey-screens/src/screens`: two directories at
    // 100% JSX-default-export density, one of which has a nested
    // subdirectory of its own matching files, the other flatter but with a
    // higher DIRECT file count.
    writePackageJson({})
    const jsxDefault = (name: string) => `export default function ${name}() {\n  return <div>${name}</div>\n}\n`
    write('views/Home.tsx', jsxDefault('Home'))
    write('views/Profile.tsx', jsxDefault('Profile'))
    write('views/settings/General.tsx', jsxDefault('General'))
    write('views/settings/Privacy.tsx', jsxDefault('Privacy'))
    write('views/settings/Billing.tsx', jsxDefault('Billing'))
    write('widgets/Card.tsx', jsxDefault('Card'))
    write('widgets/Badge.tsx', jsxDefault('Badge'))
    write('widgets/Avatar.tsx', jsxDefault('Avatar'))
    write('widgets/Tag.tsx', jsxDefault('Tag'))

    const profile = probeProject(tmpDir)
    // `views/` (2 direct + 3 nested = 5 matched) outranks `widgets/` (4
    // matched, no subtree) even though `widgets/` has more DIRECT files.
    expect(profile.pagesDir).toBe('views')
  })
})

// ---------------------------------------------------------------------------
// App root (`approot-01`) — a project's app root is not always its project
// directory.
// ---------------------------------------------------------------------------

describe('probeProject — app root', () => {
  it('treats the project directory as the app root when package.json sits there — unchanged behavior for every existing project', () => {
    writePackageJson({})
    write('pages/Home.tsx', 'export default function Home() { return <div>Home</div> }\n')

    const profile = probeProject(tmpDir)
    expect(profile.appRoot).toBe('')
    expect(profile.appRootCandidates).toBeUndefined()
    expect(profile.warnings.some((w) => w.code.startsWith('app-root-'))).toBe(false)
    expect(profile.pagesDir).toBe('pages')
  })

  it('detects a nested app root one level down, and every returned path stays project-relative', () => {
    // Shares nothing with the eSIM corpus's own `journey-screens/` naming —
    // `genericRepoShapes.test.ts` discipline.
    write('firmware-console/package.json', JSON.stringify({ name: 'firmware-console' }))
    write('firmware-console/screens/Dashboard.tsx', 'export default function Dashboard() { return <div>Dashboard</div> }\n')
    write('firmware-console/screens/Settings.tsx', 'export default function Settings() { return <div>Settings</div> }\n')

    const profile = probeProject(tmpDir)
    expect(profile.appRoot).toBe('firmware-console')
    expect(profile.pagesDir).toBe('firmware-console/screens')
    expect(profile.warnings.some((w) => w.code === 'pages-dir-heuristic')).toBe(true)
    expect(profile.pagesDirCandidates?.every((c) => c.dir.startsWith('firmware-console/'))).toBe(true)
    expect(profile.warnings.some((w) => w.code.startsWith('app-root-'))).toBe(false)
  })

  it('detects a nested app root two levels down (a monorepo apps/<name> shape)', () => {
    write('apps/web/package.json', JSON.stringify({ name: 'web' }))
    write('apps/web/screens/Home.tsx', 'export default function Home() { return <div>Home</div> }\n')

    const profile = probeProject(tmpDir)
    expect(profile.appRoot).toBe('apps/web')
    expect(profile.pagesDir).toBe('apps/web/screens')
  })

  it('ranks two candidate app roots at the same depth, warns, and returns the ranked list — never silently picks', () => {
    write('service-a/package.json', JSON.stringify({ name: 'service-a', dependencies: { react: '^18.0.0' } }))
    // service-b has a framework config — outranks service-a on that signal alone.
    write('service-b/package.json', JSON.stringify({ name: 'service-b' }))
    write('service-b/vite.config.ts', 'export default {}\n')

    const profile = probeProject(tmpDir)
    expect(profile.appRoot).toBe('service-b')
    expect(profile.appRootCandidates).toBeDefined()
    const dirs = profile.appRootCandidates!.map((c) => c.dir).sort()
    expect(dirs).toEqual(['service-a', 'service-b'])
    expect(profile.warnings.some((w) => w.code === 'app-root-ambiguous')).toBe(true)
  })

  it('degrades to the project directory itself, with a warning, when no package.json exists anywhere within the bound', () => {
    write('notes/README.md', 'hello\n')

    const profile = probeProject(tmpDir)
    expect(profile.appRoot).toBe('')
    expect(profile.warnings.some((w) => w.code === 'app-root-not-found')).toBe(true)
  })

  it('never descends into node_modules/.git/dist looking for a nested package.json', () => {
    write('node_modules/some-dep/package.json', JSON.stringify({ name: 'some-dep' }))
    write('.git/hooks/package.json', JSON.stringify({ name: 'not-real' }))

    const profile = probeProject(tmpDir)
    expect(profile.appRoot).toBe('')
    expect(profile.warnings.some((w) => w.code === 'app-root-not-found')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Style toolchain
// ---------------------------------------------------------------------------

describe('probeProject — style toolchain', () => {
  it('detects Tailwind v3 via its config file', () => {
    writePackageJson({}, { tailwindcss: '^3.4.1' })
    write('tailwind.config.js', 'module.exports = {}\n')

    const profile = probeProject(tmpDir)
    expect(profile.styleToolchain.tailwind).toEqual({ version: '3.4.1', configPath: 'tailwind.config.js' })
  })

  it('detects Tailwind v4 via an `@import "tailwindcss"` in a stylesheet, not by config presence', () => {
    writePackageJson({}, { tailwindcss: '^4.0.0' })
    write('src/index.css', '@import "tailwindcss";\n\nbody { margin: 0; }\n')

    const profile = probeProject(tmpDir)
    expect(profile.styleToolchain.tailwind).toEqual({ version: '4.0.0', configPath: 'src/index.css' })
  })

  it('warns when tailwindcss is a dependency but neither signal is found', () => {
    writePackageJson({}, { tailwindcss: '^4.0.0' })

    const profile = probeProject(tmpDir)
    expect(profile.styleToolchain.tailwind).toBeNull()
    expect(profile.warnings.some((w) => w.code === 'tailwind-config-not-found')).toBe(true)
  })

  it('detects CSS Modules by a *.module.css file anywhere in the tree', () => {
    writePackageJson({})
    write('src/components/Card.module.css', '.card { padding: 8px; }\n')

    expect(probeProject(tmpDir).styleToolchain.cssModules).toBe(true)
  })

  it('detects Sass by a .scss file even with no declared dependency', () => {
    writePackageJson({})
    write('src/styles/theme.scss', '$primary: hotpink;\n')

    expect(probeProject(tmpDir).styleToolchain.sass).toBe(true)
  })

  it('detects a postcss config path', () => {
    writePackageJson({})
    write('postcss.config.js', 'module.exports = {}\n')

    expect(probeProject(tmpDir).styleToolchain.postcssConfigPath).toBe('postcss.config.js')
  })

  it('detects styled-components as the css-in-js library', () => {
    writePackageJson({ 'styled-components': '^6.0.0' })

    expect(probeProject(tmpDir).styleToolchain.cssInJs).toBe('styled-components')
  })

  it('reports no style toolchain signals for a plain, dependency-free project', () => {
    writePackageJson({})

    const { styleToolchain } = probeProject(tmpDir)
    expect(styleToolchain).toEqual({
      tailwind: null,
      cssModules: false,
      sass: false,
      postcssConfigPath: null,
      cssInJs: null,
    })
  })
})

// ---------------------------------------------------------------------------
// Aliases — tsconfig paths merged UNDER vite resolve.alias
// ---------------------------------------------------------------------------

describe('probeProject — aliases', () => {
  it('reads tsconfig paths, stripping the trailing wildcard on both sides', () => {
    writePackageJson({})
    write(
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'], '@shared/*': ['./shared/*'] } } }),
    )

    const { aliases } = probeProject(tmpDir)
    expect(aliases['@/']).toBe('./src/')
    expect(aliases['@shared/']).toBe('./shared/')
  })

  it('lets a vite resolve.alias entry win over a tsconfig paths entry for the same key', () => {
    writePackageJson({ vite: '^5.0.0' })
    write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@': ['./src'], '@shared': ['./shared'] } } }))
    write(
      'vite.config.ts',
      [
        "import path from 'path'",
        "export default {",
        '  resolve: {',
        '    alias: {',
        "      '@': path.resolve(__dirname, './app'),",
        '    },',
        '  },',
        '}',
        '',
      ].join('\n'),
    )

    const { aliases } = probeProject(tmpDir)
    // Vite wins for the colliding key…
    expect(aliases['@']).toBe('./app')
    // …but a tsconfig-only key survives untouched.
    expect(aliases['@shared']).toBe('./shared')
  })
})

// ---------------------------------------------------------------------------
// Component packages
// ---------------------------------------------------------------------------

describe('probeProject — component packages', () => {
  function writeInstalledPackage(name: string, dts: string): void {
    write(`node_modules/${name}/package.json`, JSON.stringify({ name, version: '1.0.0', types: 'index.d.ts' }))
    write(`node_modules/${name}/index.d.ts`, dts)
  }

  it('flags a dependency whose entry .d.ts exports a PascalCase React-component declaration', () => {
    writePackageJson({ 'acme-ui': '^1.0.0', 'acme-utils': '^1.0.0' })
    writeInstalledPackage('acme-ui', 'export declare const Button: React.FC<{ label: string }>;\n')
    writeInstalledPackage('acme-utils', 'export declare function noop(): void;\n')

    const { componentPackages } = probeProject(tmpDir)
    expect(componentPackages).toEqual(['acme-ui'])
  })

  it('warns instead of scanning when dependencies are declared but node_modules is missing', () => {
    writePackageJson({ 'acme-ui': '^1.0.0' })

    const profile = probeProject(tmpDir)
    expect(profile.componentPackages).toEqual([])
    expect(profile.warnings.some((w) => w.code === 'dependencies-not-installed')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Locale capability (WS-10 §4.1)
//
// The `translations[lang]`-style fixture below is deliberately shaped exactly
// like the real `maherfayad-stack-eSIM` corpus (`journey-screens/src/i18n/
// {translations.js,LanguageContext.jsx}`) — dictionary declared in one file,
// indexed in another — because `detectLocales(...)` run directly against that
// real, un-modified project (a throwaway, read-only verification, not a
// checked-in test) returned exactly `{ keys: ['en','ar'], defaultKey: 'en',
// source: 'src/i18n/translations.js' }`, confirming the two-pass (declare
// here, index there) design is not just theoretically necessary but actually
// what real projects do.
// ---------------------------------------------------------------------------

describe('detectLocales', () => {
  it('finds a translations[lang]-style dictionary declared in a DIFFERENT file than where it is indexed', () => {
    write(
      'src/i18n/translations.js',
      "export const translations = {\n  en: { close: 'Close' },\n  ar: { close: 'إغلاق' },\n}\n",
    )
    write(
      'src/i18n/LanguageContext.jsx',
      "import { translations } from './translations'\nexport function useLanguage(lang) {\n  return translations[lang]\n}\n",
    )
    expect(detectLocales(tmpDir)).toEqual({ keys: ['en', 'ar'], defaultKey: 'en', source: 'src/i18n/translations.js' })
  })

  it('picks "en" as the default when present, regardless of source order', () => {
    write('src/dict.js', "export const dict = {\n  ar: {},\n  fr: {},\n  en: {},\n}\nconst x = dict[lang]\n")
    expect(detectLocales(tmpDir)?.defaultKey).toBe('en')
  })

  it('falls back to the first key in source order when "en" is absent', () => {
    write('src/dict.js', "export const dict = {\n  fr: {},\n  de: {},\n}\nconst x = dict[lang]\n")
    expect(detectLocales(tmpDir)?.defaultKey).toBe('fr')
  })

  it('does not false-positive on a literal (non-dynamic) index', () => {
    write('src/sizes.js', "export const sizes = {\n  sm: 4,\n  md: 8,\n}\nconst x = sizes['md']\n")
    expect(detectLocales(tmpDir)).toBeNull()
  })

  it('ignores an object literal with fewer than 2 locale-shaped keys', () => {
    write('src/dict.js', "export const dict = {\n  en: {},\n}\nconst x = dict[lang]\n")
    expect(detectLocales(tmpDir)).toBeNull()
  })

  it('detects an i18next-style `resources: { en: {...}, ar: {...} }` config object', () => {
    write(
      'src/i18n.js',
      "import i18next from 'i18next'\ni18next.init({\n  resources: {\n    en: { translation: {} },\n    ar: { translation: {} },\n  },\n  lng: 'en',\n})\n",
    )
    expect(detectLocales(tmpDir)).toEqual({ keys: ['en', 'ar'], defaultKey: 'en', source: 'src/i18n.js' })
  })

  it('detects a locales/*.json directory, alphabetically (a directory has no "source order")', () => {
    write('src/locales/en.json', '{ "hello": "Hello" }')
    write('src/locales/ar.json', '{ "hello": "مرحبا" }')
    expect(detectLocales(tmpDir)).toEqual({ keys: ['ar', 'en'], defaultKey: 'en', source: 'src/locales' })
  })

  it('returns null for a project with no detectable locale dictionary', () => {
    write('src/App.jsx', 'export default function App() { return <div>Hi</div> }\n')
    expect(detectLocales(tmpDir)).toBeNull()
  })

  it('probeProject wires the result onto ProjectProfile.locales, and omits the field entirely when none is found', () => {
    write('src/dict.js', "export const dict = {\n  en: {},\n  ar: {},\n}\nconst x = dict[lang]\n")
    expect(probeProject(tmpDir).locales).toEqual({ keys: ['en', 'ar'], defaultKey: 'en', source: 'src/dict.js' })

    const withoutDict = probeProject(fs.mkdtempSync(path.join(os.tmpdir(), 'project-probe-nolocale-')))
    expect('locales' in withoutDict).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Dark-mode capability (WS-10 §3.1)
// ---------------------------------------------------------------------------

describe('probeProject — colorScheme', () => {
  it('reports "none" when no dark-mode mechanism is detectable', () => {
    write('src/App.css', '.btn { color: black; }\n')
    expect(probeProject(tmpDir).colorScheme).toEqual({ mechanism: 'none' })
  })

  it('detects a Tailwind v3 class-based darkMode config', () => {
    writePackageJson({ tailwindcss: '^3.4.0' })
    write('tailwind.config.js', 'module.exports = { darkMode: "class", theme: {} }\n')
    expect(probeProject(tmpDir).colorScheme).toEqual({ mechanism: 'class', selector: '.dark' })
  })

  it('detects a Tailwind v3 array-form darkMode config', () => {
    writePackageJson({ tailwindcss: '^3.4.0' })
    write('tailwind.config.js', "module.exports = { darkMode: ['class', '.dark-mode'], theme: {} }\n")
    expect(probeProject(tmpDir).colorScheme).toEqual({ mechanism: 'class', selector: '.dark' })
  })

  it('detects a hand-authored .dark class selector with no Tailwind at all', () => {
    write('src/theme.css', ':root { --bg: white; }\n.dark { --bg: black; }\n')
    expect(probeProject(tmpDir).colorScheme).toEqual({ mechanism: 'class', selector: '.dark' })
  })

  it('does not false-positive on a class name that merely starts with "dark"', () => {
    write('src/theme.css', '.darkened { opacity: 0.5; }\n')
    expect(probeProject(tmpDir).colorScheme).toEqual({ mechanism: 'none' })
  })

  it('detects a [data-theme="dark"] attribute selector', () => {
    write('src/theme.css', '[data-theme="dark"] { --bg: black; }\n')
    expect(probeProject(tmpDir).colorScheme).toEqual({ mechanism: 'class', selector: '[data-theme="dark"]' })
  })

  it('detects @media (prefers-color-scheme: dark) when there is no class mechanism', () => {
    write('src/theme.css', '@media (prefers-color-scheme: dark) {\n  body { color: white; }\n}\n')
    expect(probeProject(tmpDir).colorScheme).toEqual({ mechanism: 'media' })
  })

  it('prefers the class mechanism over an incidental prefers-color-scheme query', () => {
    write(
      'src/theme.css',
      '.dark { --bg: black; }\n@media (prefers-color-scheme: dark) {\n  body { color: white; }\n}\n',
    )
    expect(probeProject(tmpDir).colorScheme).toEqual({ mechanism: 'class', selector: '.dark' })
  })

  it('does not match a compound media condition — false negative is the honest outcome', () => {
    write('src/theme.css', '@media (min-width: 768px) and (prefers-color-scheme: dark) {\n  body { color: white; }\n}\n')
    expect(probeProject(tmpDir).colorScheme).toEqual({ mechanism: 'none' })
  })
})

// ---------------------------------------------------------------------------
// studioMeta — tolerant partial reads, degrade-don't-throw, pagesDir escape
// ---------------------------------------------------------------------------

describe('readStudioMeta', () => {
  it('resolves a partial meta.json containing only pagesDir', () => {
    write('.studio/meta.json', JSON.stringify({ pagesDir: 'src/screens' }))
    expect(readStudioMeta(tmpDir)).toEqual({ pagesDir: 'src/screens' })
  })

  it('degrades a malformed meta.json to {} rather than throwing', () => {
    write('.studio/meta.json', '{ this is not valid json')
    expect(() => readStudioMeta(tmpDir)).not.toThrow()
    expect(readStudioMeta(tmpDir)).toEqual({})
  })

  it('returns {} when no meta.json exists at all', () => {
    expect(readStudioMeta(tmpDir)).toEqual({})
  })

  it('strips a pagesDir of "../.." rather than trusting it', () => {
    write('.studio/meta.json', JSON.stringify({ displayName: 'Evil', pagesDir: '../..' }))
    const meta = readStudioMeta(tmpDir)
    expect(meta.pagesDir).toBeUndefined()
    expect(meta.displayName).toBe('Evil')
  })

  it('strips an absolute pagesDir override', () => {
    const absoluteElsewhere = path.join(os.tmpdir(), 'somewhere-else')
    write('.studio/meta.json', JSON.stringify({ pagesDir: absoluteElsewhere }))
    expect(readStudioMeta(tmpDir).pagesDir).toBeUndefined()
  })

  // `profile` is a regenerable cache and its schema WILL gain fields as the
  // probe grows. `parseJsonWithFallback` is all-or-nothing, so without the
  // targeted retry in `readStudioMeta` the first shape change would fail the
  // whole file and take `pagesDir` with it — losing the one field that cannot
  // be recovered by re-probing, on every already-imported project on disk.
  it('drops a stale profile cache WITHOUT losing user intent alongside it', () => {
    write(
      '.studio/meta.json',
      JSON.stringify({
        displayName: 'Imported repo',
        pagesDir: 'src/screens',
        previewLocale: 'en',
        profile: { framework: 'from-a-future-version', somethingRemoved: true },
      }),
    )
    const meta = readStudioMeta(tmpDir)
    expect(meta.profile).toBeUndefined()
    expect(meta.pagesDir).toBe('src/screens')
    expect(meta.displayName).toBe('Imported repo')
    // WS-10 §5.2 — a legacy `previewLocale` is folded into `previewAxes.locale`
    // and never returned as `previewLocale` itself; see `foldLegacyPreviewLocale`.
    expect(meta.previewLocale).toBeUndefined()
    expect(meta.previewAxes).toEqual({ locale: 'en' })
  })

  it('keeps a profile that still matches the current schema', () => {
    const profile = probeProject(tmpDir)
    write('.studio/meta.json', JSON.stringify({ pagesDir: 'src/screens', profile }))
    expect(readStudioMeta(tmpDir).profile).toEqual(profile)
  })

  // WS-10 §5.2 — the fold this workstream added: a pre-Phase-3 `meta.json`
  // (every project imported before this shipped) still resolves to a working
  // `previewAxes.locale`, and re-reading never surfaces the legacy field.
  describe('legacy previewLocale fold', () => {
    it('folds a bare previewLocale into previewAxes.locale', () => {
      write('.studio/meta.json', JSON.stringify({ previewLocale: 'ar' }))
      const meta = readStudioMeta(tmpDir)
      expect(meta.previewLocale).toBeUndefined()
      expect(meta.previewAxes).toEqual({ locale: 'ar' })
    })

    it('merges the folded locale onto an existing previewAxes rather than replacing it', () => {
      write(
        '.studio/meta.json',
        JSON.stringify({ previewLocale: 'ar', previewAxes: { direction: 'rtl' } }),
      )
      const meta = readStudioMeta(tmpDir)
      expect(meta.previewAxes).toEqual({ direction: 'rtl', locale: 'ar' })
    })

    it('an existing previewAxes.locale wins over a legacy previewLocale', () => {
      write(
        '.studio/meta.json',
        JSON.stringify({ previewLocale: 'ar', previewAxes: { locale: 'en' } }),
      )
      const meta = readStudioMeta(tmpDir)
      expect(meta.previewAxes).toEqual({ locale: 'en' })
    })

    it('a file with no previewLocale at all is untouched', () => {
      write('.studio/meta.json', JSON.stringify({ previewAxes: { direction: 'ltr' } }))
      const meta = readStudioMeta(tmpDir)
      expect(meta.previewAxes).toEqual({ direction: 'ltr' })
    })
  })
})

describe('mergeStudioMeta', () => {
  it('patches one field without clobbering sibling fields', () => {
    writeStudioMeta(tmpDir, { displayName: 'Original', pagesDir: 'src/screens' })
    const merged = mergeStudioMeta(tmpDir, { trust: 'render-packages' })
    expect(merged).toEqual({ displayName: 'Original', pagesDir: 'src/screens', trust: 'render-packages' })
    expect(readStudioMeta(tmpDir)).toEqual(merged)
  })

  it('creates a fresh meta.json when none exists yet', () => {
    const merged = mergeStudioMeta(tmpDir, { displayName: 'Fresh' })
    expect(merged).toEqual({ displayName: 'Fresh' })
  })
})

// ---------------------------------------------------------------------------
// Route — tryServeStudioProbe
// ---------------------------------------------------------------------------

describe('tryServeStudioProbe', () => {
  function makeRequest(pathAndQuery: string, init?: RequestInit): { req: Request; url: URL; pathname: string } {
    const url = new URL(`http://localhost${pathAndQuery}`)
    const req = new Request(url, init)
    return { req, url, pathname: url.pathname }
  }

  it('returns null for an unrelated path', async () => {
    const { req, url, pathname } = makeRequest('/admin/api/studio/other')
    expect(await tryServeStudioProbe(req, url, pathname)).toBeNull()
  })

  it('GET probes fresh and does not persist when no cached profile exists', async () => {
    writePackageJson({ vite: '^5.0.0' })
    write('vite.config.ts', 'export default {}\n')

    const { req, url, pathname } = makeRequest(`/admin/api/studio/probe?dir=${encodeURIComponent(tmpDir)}`)
    const res = await tryServeStudioProbe(req, url, pathname)
    expect(res).not.toBeNull()
    const body = (await res!.json()) as { profile: ProjectProfile }
    expect(body.profile.framework).toBe('vite')
    // Read-only — must not have written a meta.json.
    expect(fs.existsSync(path.join(tmpDir, '.studio', 'meta.json'))).toBe(false)
  })

  it('GET returns the cached profile verbatim without re-probing', async () => {
    writePackageJson({ vite: '^5.0.0' })
    write('vite.config.ts', 'export default {}\n')
    const cachedProfile: ProjectProfile = {
      framework: 'astro',
      appRoot: '',
      pagesDir: 'src/pages',
      routeStyle: 'file-router',
      entryFiles: [],
      packageManager: 'bun',
      styleToolchain: { tailwind: null, cssModules: false, sass: false, postcssConfigPath: null, cssInJs: null },
      componentPackages: [],
      colorScheme: { mechanism: 'none' },
      aliases: {},
      warnings: [],
    }
    writeStudioMeta(tmpDir, { profile: cachedProfile })

    const { req, url, pathname } = makeRequest(`/admin/api/studio/probe?dir=${encodeURIComponent(tmpDir)}`)
    const res = await tryServeStudioProbe(req, url, pathname)
    const body = (await res!.json()) as { profile: ProjectProfile }
    // A live probe of this fixture would say "vite" — proving the cache was used, not a fresh probe.
    expect(body.profile.framework).toBe('astro')
  })

  it('POST re-probes and persists the profile via a merging write', async () => {
    writePackageJson({ 'react-scripts': '^5.0.1' })
    write('src/index.tsx', 'console.log("entry")\n')
    writeStudioMeta(tmpDir, { displayName: 'Keep Me', pagesDir: 'src' })

    const { req, url, pathname } = makeRequest('/admin/api/studio/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dir: tmpDir }),
    })
    const res = await tryServeStudioProbe(req, url, pathname)
    expect(res).not.toBeNull()
    const body = (await res!.json()) as { profile: ProjectProfile }
    expect(body.profile.framework).toBe('cra')

    const onDisk = readStudioMeta(tmpDir)
    expect(onDisk.displayName).toBe('Keep Me')
    expect(onDisk.pagesDir).toBe('src')
    expect((onDisk.profile as ProjectProfile).framework).toBe('cra')
  })
})

/**
 * A `.studio/meta.json` is user data written by whatever Studio version last
 * probed the project, and `readStudioMeta` soft-falls back to `{}` rather than
 * throwing. So a newly-REQUIRED profile field does not fail loudly — it drops
 * the entire `profile`, taking `pagesDir` with it, and the board silently loads
 * zero pages. WS-10 Phase 1 shipped `colorScheme` required and did exactly that
 * to every project imported before it. These tests are the gate.
 */
describe('readStudioMeta — forward compatibility with older meta.json files', () => {
  it('keeps the profile (and pagesDir) when a newer optional field is absent', () => {
    // Deliberately hand-written in the pre-WS-10 shape: no colorScheme, no locales.
    fs.mkdirSync(path.join(tmpDir, '.studio'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, '.studio', 'meta.json'),
      JSON.stringify({
        displayName: 'Legacy',
        profile: {
          framework: 'vite',
          appRoot: 'app',
          pagesDir: 'app/src/screens',
          routeStyle: 'flat',
          entryFiles: ['app/src/main.jsx'],
          packageManager: 'npm',
          styleToolchain: { tailwind: null, cssModules: false, sass: false, postcssConfigPath: null, cssInJs: null },
          componentPackages: [],
          aliases: {},
          warnings: [],
        },
      }),
    )

    const meta = readStudioMeta(tmpDir)
    expect(meta.displayName).toBe('Legacy')
    expect(meta.profile).toBeDefined()
    expect((meta.profile as ProjectProfile).pagesDir).toBe('app/src/screens')
    expect((meta.profile as ProjectProfile).colorScheme).toBeUndefined()
  })

  it('drops only unknown junk, never a profile that is merely older', () => {
    fs.mkdirSync(path.join(tmpDir, '.studio'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, '.studio', 'meta.json'),
      JSON.stringify({ displayName: 'Junk', profile: { framework: 'not-a-framework' } }),
    )
    // A genuinely invalid profile SHOULD be dropped — that is the soft fallback
    // working as designed. The bug was dropping a VALID older one.
    expect(readStudioMeta(tmpDir).profile).toBeUndefined()
  })
})
