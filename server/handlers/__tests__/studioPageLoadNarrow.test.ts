/**
 * `loadStudioPages(dir, { pageIds })` — the narrowed COMPUTE behind a
 * targeted reload (`GET /admin/api/studio/load?pageIds=`).
 *
 * The filter used to live purely in the response shaping: every narrow reload
 * still converted all forty pages and then threw thirty-nine away. It now
 * reaches the compute — but only the one stage it honestly can. These tests
 * pin both halves of that claim:
 *
 *   1. **What it skips.** Only the requested pages come back.
 *   2. **What it must NOT skip.** The project-wide registries
 *      (`styleRules`, `styleRuleSources`, `conditions`, `authoredCss`,
 *      `componentSources`) stay byte-identical to a full, unfiltered load —
 *      including rules contributed by a stylesheet only an UNREQUESTED page
 *      imports. The client replaces its registry wholesale from this response,
 *      so shrinking it here is `canvas-14`'s "renders against last minute's
 *      stylesheet" bug with a new cause.
 *   3. **Equivalence.** The requested page's own content is identical either
 *      way — narrowing changes cost, never output.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { clearPageParseCache } from '../studio/pageParseCache'
import { projectsRootDir } from '../studioProjects'
import { loadStudioPages } from '../studioPageLoad'

describe('loadStudioPages narrowed by pageIds', () => {
  let wsDir: string

  function write(relPath: string, contents: string): void {
    const full = path.join(wsDir, ...relPath.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, contents, 'utf8')
  }

  beforeEach(() => {
    clearPageParseCache()
    const root = projectsRootDir()
    fs.mkdirSync(root, { recursive: true })
    wsDir = fs.mkdtempSync(path.join(root, '__narrow_load_test_'))

    write('pages/Home.tsx', [
      "import './Home.css'",
      'export default function Home() {',
      '  return <div className="hero">Home</div>',
      '}',
      '',
    ].join('\n'))
    write('pages/Home.css', '.hero { color: red; }\n')
    // About's stylesheet is imported by NO other page — it is exactly the
    // registry content a narrowed load would lose if it skipped About's parse.
    write('pages/About.tsx', [
      "import './About.css'",
      'export default function About() {',
      '  return <div className="about-panel">About</div>',
      '}',
      '',
    ].join('\n'))
    write('pages/About.css', '.about-panel { color: blue; }\n@media (max-width: 600px) { .about-panel { color: green; } }\n')
  })

  afterEach(() => {
    fs.rmSync(wsDir, { recursive: true, force: true })
    clearPageParseCache()
  })

  it('returns ONLY the requested pages', async () => {
    const narrow = await loadStudioPages(wsDir, { pageIds: ['home'] })
    expect(narrow.pages.map((page) => page.id)).toEqual(['home'])
  })

  it('keeps the project-wide style registry COMPLETE — including rules only an unrequested page imports', async () => {
    const full = await loadStudioPages(wsDir)
    const narrow = await loadStudioPages(wsDir, { pageIds: ['home'] })

    expect(narrow.styleRules).toEqual(full.styleRules)
    expect(narrow.styleRuleSources).toEqual(full.styleRuleSources)
    expect(narrow.conditions).toEqual(full.conditions)
    expect(narrow.authoredCss).toEqual(full.authoredCss)
    expect(narrow.componentSources).toEqual(full.componentSources)
    expect(narrow.vendorCss).toEqual(full.vendorCss)

    // Named explicitly, so this test fails loudly rather than by an empty-vs-
    // empty `toEqual` if the fixture ever stops producing rules at all.
    const names = Object.values(narrow.styleRules).map((rule) => rule.name)
    expect(names).toContain('hero')
    expect(names).toContain('about-panel')
    expect(narrow.conditions.length).toBeGreaterThan(0)
  })

  it('a narrowed page is byte-identical to the same page from a full load', async () => {
    const full = await loadStudioPages(wsDir)
    const narrow = await loadStudioPages(wsDir, { pageIds: ['home'] })
    expect(narrow.pages[0]).toEqual(full.pages.find((page) => page.id === 'home')!)
  })

  it('an id matching no route yields no pages and still a full registry — never an error', async () => {
    const full = await loadStudioPages(wsDir)
    const narrow = await loadStudioPages(wsDir, { pageIds: ['ghost'] })
    expect(narrow.pages).toEqual([])
    expect(narrow.styleRules).toEqual(full.styleRules)
  })

  it('an explicit full id list is identical to no filter at all', async () => {
    const full = await loadStudioPages(wsDir)
    const narrow = await loadStudioPages(wsDir, { pageIds: ['home', 'about'] })
    expect(narrow.pages).toEqual(full.pages)
  })
})
