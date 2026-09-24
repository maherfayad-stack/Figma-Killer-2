/**
 * studio_find_icon — ranking over synthetic names, and the handler over
 * Studio's real vendored design-system catalog (the one the picker offers).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ToolContext } from '../../../runtime/types'
import { findIcons, scoreIcon, studioFindIconMcpTools } from './findIconTool'
import type { StudioIcon } from '../../../../handlers/studio/iconCatalog'

const tool = studioFindIconMcpTools[0]!

function icon(name: string, group = 'line-icons', pkg = '@acme/icons'): StudioIcon {
  return { id: `${pkg}:${group}/${name}.svg`, name, group, pkg, packagePath: `icons/${group}/${name}.svg`, markup: `<svg><title>${name}</title></svg>` }
}

function ctx(): ToolContext {
  return { db: {} as never, userId: 'u1', capabilities: [], conversationId: 'c1', snapshot: null, signal: new AbortController().signal }
}

describe('studio_find_icon — ranking', () => {
  const catalog = ['arrowLeft', 'arrowRight', 'chevron-left', 'magnifyingGlass', 'x', 'trash-can', 'calendar', 'bell', 'bellboy'].map((name) => icon(name))
  const top = (query: string) => findIcons('/nowhere', { query }, catalog).matches.map((m) => m.name)

  it('matches camelCase and kebab names word by word, whole query first', () => {
    expect(top('arrow left')[0]).toBe('arrowLeft')
    expect(top('arrow left')).toContain('chevron-left')
  })

  it('finds the names designers disagree on through synonyms', () => {
    expect(top('search')[0]).toBe('magnifyingGlass')
    expect(top('close')[0]).toBe('x')
    expect(top('delete')[0]).toBe('trash-can')
  })

  it('tolerates a typo', () => {
    expect(top('calender')[0]).toBe('calendar')
  })

  it('an exact word beats a longer name that merely starts with it', () => {
    expect(top('bell')[0]).toBe('bell')
  })

  it('scores nothing for an unrelated word', () => {
    expect(scoreIcon(['submarine'], { name: 'calendar', group: 'line-icons' }).score).toBe(0)
    expect(top('submarine')).toEqual([])
  })

  it('writes a package icon as a ?raw import of its file inside the package', () => {
    const [match] = findIcons('/nowhere', { query: 'calendar' }, catalog).matches
    expect(match!.import).toBe("import calendarSvg from '@acme/icons/icons/line-icons/calendar.svg?raw'")
    expect(match!.usage).toContain('dangerouslySetInnerHTML={{ __html: calendarSvg }}')
    expect(match!.markup).toBeUndefined()
  })
})

describe('studio_find_icon — the handler', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-find-icon-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('is an ungated read with a short description', () => {
    expect(tool.requiresWrite ?? false).toBe(false)
    expect(tool.sideEffects).toBe('none')
    expect(tool.requiredCapabilities).toEqual([])
    expect(tool.description.length).toBeLessThanOrEqual(900)
  })

  it('with no icon set, says so and what to ask for, instead of an empty list', async () => {
    const result = (await tool.handler!({ dir, query: 'search' }, ctx())) as Record<string, unknown>
    expect(result.ok).toBe(true)
    expect(result.catalogSize).toBe(0)
    expect(String(result.message)).toContain('never draw one')
  })

  describe('over Studio\'s built-in design system', () => {
    beforeEach(() => {
      // `isDesignSystemBacked`: the project carries the design-system folder.
      fs.mkdirSync(path.join(dir, 'design-system', 'icons', 'line-icons'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'design-system', 'index.js'), 'export {}\n')
      fs.writeFileSync(path.join(dir, 'design-system', 'icons', 'line-icons', 'calendar.svg'), '<svg/>')
    })

    it('an icon already in the project comes back as a ?raw import relative to forFile', async () => {
      const result = (await tool.handler!({ dir, query: 'calendar', forFile: 'pages/Trips.tsx', limit: 1 }, ctx())) as { matches: Array<Record<string, string>> }
      expect(result.matches[0]!.name).toBe('calendar')
      expect(result.matches[0]!.import).toBe("import calendarSvg from '../design-system/icons/line-icons/calendar.svg?raw'")
      expect(result.matches[0]!.markup).toBeUndefined()
    })

    it('one that is not comes back with its markup and where to save it', async () => {
      const result = (await tool.handler!({ dir, query: 'close', forFile: 'pages/Trips.tsx' }, ctx())) as { catalogSize: number; matches: Array<Record<string, string>> }
      expect(result.catalogSize).toBeGreaterThan(100)
      const x = result.matches.find((match) => match.name === 'x')!
      expect(x.saveAs).toBe('src/assets/icons/x.svg')
      expect(x.markup).toContain('<svg')
      expect(x.import).toBe("import xSvg from '../src/assets/icons/x.svg?raw'")
    })

    it('refuses a forFile outside the project', async () => {
      const result = (await tool.handler!({ dir, query: 'close', forFile: '../../etc/x.tsx' }, ctx())) as Record<string, unknown>
      expect(result.ok).toBe(false)
    })
  })
})
