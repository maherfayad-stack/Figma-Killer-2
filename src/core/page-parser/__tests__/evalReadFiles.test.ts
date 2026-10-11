/**
 * WB-2 at the parser's own altitude — `StaticEvalOptions.readFiles` names every
 * file a value was read out of, and a memo hit names them too.
 *
 * `server/handlers/__tests__/studioPageLoadEvaluatorDeps.test.ts` proves the
 * consequence (an edit to a dictionary survives the next load); this file pins
 * the contract the parse cache is built on, per source of a value: a
 * cross-file const two hops away, an imported pure function (Tier C), a
 * provider (Tier B), a `?raw` icon, an image, and a CSS-in-JS interpolation.
 * Each is parsed TWICE against one project, because the second parse is
 * answered from a memo and must still report what the first one read.
 *
 * Fixture: a weather dashboard — nothing from the eSIM corpus, per
 * `genericRepoShapes.test.ts`'s discipline.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Project } from 'ts-morph'
import { createWorkspaceProject } from '../componentSources'
import { parsePageFile } from '../parsePageFile'
import { createPageEvalBudget } from '../staticEval'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-read-files-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function write(relPath: string, contents: string): string {
  const full = path.join(tmpDir, ...relPath.split('/'))
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, contents, 'utf8')
  return full
}

const abs = (relPath: string): string => path.resolve(tmpDir, ...relPath.split('/'))

/** Parses `page` with evaluation on and returns every file the parse reported reading. */
function readsOf(project: Project, page: string): Set<string> {
  const readFiles = new Set<string>()
  parsePageFile(abs(page), tmpDir, project, { workspaceRoot: tmpDir, pageBudget: createPageEvalBudget(), readFiles })
  return readFiles
}

/** Two pages with the same body read the same values — the second one through the memos the first filled. */
function twoReaders(body: string, imports: string): [string, string] {
  for (const name of ['Today', 'Tomorrow']) {
    write(`pages/${name}.tsx`, [imports, `export default function ${name}() {`, `  return ${body}`, '}', ''].join('\n'))
  }
  return ['pages/Today.tsx', 'pages/Tomorrow.tsx']
}

describe('readFiles — every file a value came from, replayed on a memo hit', () => {
  it('a const two modules away', () => {
    write('src/units.ts', "export const UNITS = { temp: 'Celsius' }\n")
    write('src/labels.ts', "import { UNITS } from './units'\nexport const LABELS = { scale: UNITS.temp }\n")
    const pages = twoReaders('<p>{LABELS.scale}</p>', "import { LABELS } from '../src/labels'")
    const project = createWorkspaceProject(tmpDir)

    for (const page of pages) {
      const reads = readsOf(project, page)
      expect(reads.has(abs('src/labels.ts'))).toBe(true)
      expect(reads.has(abs('src/units.ts'))).toBe(true)
    }
  })

  it('an imported pure function Tier C calls', () => {
    write('src/format.ts', 'export const shout = (text) => text.toUpperCase()\n')
    const pages = twoReaders("<p>{shout('rain')}</p>", "import { shout } from '../src/format'")
    const project = createWorkspaceProject(tmpDir)

    for (const page of pages) expect(readsOf(project, page).has(abs('src/format.ts'))).toBe(true)
  })

  it('a provider traced through a hook (Tier B), declared in a file of its own', () => {
    // The hook and the context live in one module and the provider in
    // another, so only the TRACE ever reads the provider's file — a page
    // imports the hook, never the provider.
    write('src/units/useUnits.ts', [
      "import { createContext, useContext } from 'react'",
      'export const UnitsCtx = createContext(null)',
      'export function useUnits() {',
      '  return useContext(UnitsCtx)',
      '}',
      '',
    ].join('\n'))
    write('src/units/UnitsProvider.tsx', [
      "import { UnitsCtx } from './useUnits'",
      'export function UnitsProvider({ children }) {',
      "  const value = { wind: 'km/h' }",
      '  return <UnitsCtx.Provider value={value}>{children}</UnitsCtx.Provider>',
      '}',
      '',
    ].join('\n'))
    for (const name of ['Today', 'Tomorrow']) {
      write(`pages/${name}.tsx`, [
        "import { useUnits } from '../src/units/useUnits'",
        `export default function ${name}() {`,
        '  const { wind } = useUnits()',
        '  return <p>{wind}</p>',
        '}',
        '',
      ].join('\n'))
    }
    const project = createWorkspaceProject(tmpDir)

    for (const page of ['pages/Today.tsx', 'pages/Tomorrow.tsx']) {
      const reads = readsOf(project, page)
      expect(reads.has(abs('src/units/useUnits.ts'))).toBe(true)
      expect(reads.has(abs('src/units/UnitsProvider.tsx'))).toBe(true)
    }
  })

  it('a ?raw icon and an image import', () => {
    write('src/icons/sun.svg', '<svg viewBox="0 0 4 4"><circle r="2"/></svg>\n')
    write('src/img/map.png', 'not really a png')
    write('pages/Today.tsx', [
      "import sun from '../src/icons/sun.svg?raw'",
      "import map from '../src/img/map.png'",
      'export default function Today() {',
      '  return <div><span dangerouslySetInnerHTML={{ __html: sun }} /><img src={map} alt="" /></div>',
      '}',
      '',
    ].join('\n'))
    const reads = readsOf(createWorkspaceProject(tmpDir), 'pages/Today.tsx')
    expect(reads.has(fs.realpathSync.native(abs('src/icons/sun.svg')))).toBe(true)
    expect(reads.has(fs.realpathSync.native(abs('src/img/map.png')))).toBe(true)
  })

  it('a CSS-in-JS interpolation reading a theme token', () => {
    write('src/tokens.ts', "export const tokens = { gap: '12px' }\n")
    write('src/Card.tsx', [
      "import styled from 'styled-components'",
      "import { tokens } from './tokens'",
      'export const Card = styled.section`',
      '  padding: ${tokens.gap};',
      '`',
      '',
    ].join('\n'))
    const pages = twoReaders('<Card>Forecast</Card>', "import { Card } from '../src/Card'")
    const project = createWorkspaceProject(tmpDir)

    for (const page of pages) {
      const reads = readsOf(project, page)
      expect(reads.has(abs('src/Card.tsx'))).toBe(true)
      expect(reads.has(abs('src/tokens.ts'))).toBe(true)
    }
  })

  it('reports nothing for a page whose values are all literals or out of reach', () => {
    write('pages/Today.tsx', [
      "import { forecast } from 'weather-sdk'",
      'export default function Today() {',
      '  return <div><h1>Weather</h1><p>{forecast.summary}</p></div>',
      '}',
      '',
    ].join('\n'))
    expect([...readsOf(createWorkspaceProject(tmpDir), 'pages/Today.tsx')]).toEqual([])
  })
})
