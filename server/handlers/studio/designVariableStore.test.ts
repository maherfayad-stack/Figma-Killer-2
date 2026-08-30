import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  getDesignVariableSet,
  ingestDesignVariables,
  listDesignVariableSets,
  removeDesignVariableSet,
  resolveApplicableDesignVariableSets,
} from './designVariableStore'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-design-variable-store-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('ingestDesignVariables', () => {
  it('normalises colours and sizes, and keeps an unrecognisable value as "other" without dropping it', () => {
    const result = ingestDesignVariables(
      dir,
      [
        { name: 'coral/100', raw: '#EF4550' },
        { name: 'spacing/md', raw: '16px' },
        { name: 'font/family', raw: 'Inter' },
      ],
      { source: 'figma get_variable_defs on https://figma.example/file/abc' },
    )

    expect(result.colorCount).toBe(1)
    expect(result.sizeCount).toBe(1)
    expect(result.otherCount).toBe(1)
    expect(result.duplicatesDropped).toBe(0)

    const other = result.set.variables.find((v) => v.name === 'font/family')!
    expect(other.kind).toBe('other')
    expect(other.raw).toBe('Inter') // preserved verbatim even though unrecognised
    expect(other.hex).toBeUndefined()
    expect(other.px).toBeUndefined()
  })

  it('collapses duplicate names WITHIN one ingest call, last wins, and reports the count', () => {
    const result = ingestDesignVariables(
      dir,
      [
        { name: 'coral/100', raw: '#000000' },
        { name: 'coral/100', raw: '#EF4550' }, // should win
      ],
      { source: 'test' },
    )
    expect(result.set.variables).toHaveLength(1)
    expect(result.set.variables[0]!.hex).toBe('#ef4550')
    expect(result.duplicatesDropped).toBe(1)
  })

  it('persists the set durably — a fresh read sees it', () => {
    const { set } = ingestDesignVariables(dir, [{ name: 'a', raw: '#000' }], { source: 'test' })
    const reread = getDesignVariableSet(dir, set.id)
    expect(reread?.id).toBe(set.id)
    expect(reread?.variables).toHaveLength(1)
  })

  it('two separate ingest calls create two independently addressable sets — no cross-set deduplication', () => {
    const first = ingestDesignVariables(dir, [{ name: 'a', raw: '#111111' }], { source: 'call 1' })
    const second = ingestDesignVariables(dir, [{ name: 'a', raw: '#222222' }], { source: 'call 2' })
    expect(first.set.id).not.toBe(second.set.id)
    expect(getDesignVariableSet(dir, first.set.id)?.variables[0]!.hex).toBe('#111111')
    expect(getDesignVariableSet(dir, second.set.id)?.variables[0]!.hex).toBe('#222222')
  })

  it('stores pageId/referenceId/label scoping metadata when supplied, and omits it when not', () => {
    const scoped = ingestDesignVariables(dir, [{ name: 'a', raw: '#000' }], {
      source: 'test',
      pageId: 'src/screens/Home.tsx',
      referenceId: 'ref-1',
      label: 'Design system',
    })
    expect(scoped.set.pageId).toBe('src/screens/Home.tsx')
    expect(scoped.set.referenceId).toBe('ref-1')
    expect(scoped.set.label).toBe('Design system')

    const unscoped = ingestDesignVariables(dir, [{ name: 'a', raw: '#000' }], { source: 'test' })
    expect(unscoped.set.pageId).toBeUndefined()
    expect(unscoped.set.referenceId).toBeUndefined()
  })
})

describe('listDesignVariableSets', () => {
  it('returns summaries, not full variable arrays', () => {
    ingestDesignVariables(dir, [{ name: 'a', raw: '#000' }, { name: 'b', raw: '16px' }], { source: 'test' })
    const { sets } = listDesignVariableSets(dir, {}, undefined)
    expect(sets).toHaveLength(1)
    expect(sets[0]!.variableCount).toBe(2)
    expect(sets[0]!.colorCount).toBe(1)
    expect(sets[0]!.sizeCount).toBe(1)
    expect((sets[0] as unknown as { variables?: unknown }).variables).toBeUndefined()
  })

  it('filters by pageId and referenceId', () => {
    ingestDesignVariables(dir, [{ name: 'a', raw: '#000' }], { source: 'test', pageId: 'Home.tsx' })
    ingestDesignVariables(dir, [{ name: 'a', raw: '#000' }], { source: 'test', referenceId: 'ref-1' })
    ingestDesignVariables(dir, [{ name: 'a', raw: '#000' }], { source: 'test' })

    expect(listDesignVariableSets(dir, { pageId: 'Home.tsx' }, undefined).totalCount).toBe(1)
    expect(listDesignVariableSets(dir, { referenceId: 'ref-1' }, undefined).totalCount).toBe(1)
    expect(listDesignVariableSets(dir, {}, undefined).totalCount).toBe(3)
  })

  it('caps and reports truncation honestly, never a silent drop', () => {
    for (let i = 0; i < 5; i += 1) {
      ingestDesignVariables(dir, [{ name: 'a', raw: '#000' }], { source: `set ${i}` })
    }
    const capped = listDesignVariableSets(dir, {}, 2)
    expect(capped.sets).toHaveLength(2)
    expect(capped.totalCount).toBe(5)
    expect(capped.truncated).toBe(true)
    expect(capped.omittedCount).toBe(3)
  })

  it('an empty project reports zero, not an error', () => {
    const result = listDesignVariableSets(dir, {}, undefined)
    expect(result.sets).toEqual([])
    expect(result.totalCount).toBe(0)
    expect(result.truncated).toBe(false)
  })
})

describe('getDesignVariableSet', () => {
  it('returns null for an unknown id', () => {
    expect(getDesignVariableSet(dir, 'does-not-exist')).toBeNull()
  })

  it('rejects a malformed id shape outright, without touching the manifest contents', () => {
    // Same pattern as designReferenceStore's REFERENCE_ID_PATTERN gate — a
    // hand-edited manifest.json is untrusted input.
    expect(getDesignVariableSet(dir, '../../etc/passwd')).toBeNull()
    expect(getDesignVariableSet(dir, '<script>')).toBeNull()
  })
})

describe('removeDesignVariableSet', () => {
  it('removes an existing set', () => {
    const { set } = ingestDesignVariables(dir, [{ name: 'a', raw: '#000' }], { source: 'test' })
    const result = removeDesignVariableSet(dir, set.id)
    expect(result.removed).toBe(true)
    expect(getDesignVariableSet(dir, set.id)).toBeNull()
  })

  it('is idempotent — removing an unknown or already-removed id is not an error', () => {
    expect(removeDesignVariableSet(dir, 'never-existed').removed).toBe(false)
    const { set } = ingestDesignVariables(dir, [{ name: 'a', raw: '#000' }], { source: 'test' })
    removeDesignVariableSet(dir, set.id)
    expect(removeDesignVariableSet(dir, set.id).removed).toBe(false)
  })
})

describe('resolveApplicableDesignVariableSets', () => {
  it('includes project-wide sets for every page', () => {
    ingestDesignVariables(dir, [{ name: 'a', raw: '#000' }], { source: 'project-wide' })
    const applicable = resolveApplicableDesignVariableSets(dir, 'src/screens/Anything.tsx', undefined)
    expect(applicable).toHaveLength(1)
    expect(applicable[0]!.source).toBe('project-wide')
  })

  it('excludes a set scoped to a DIFFERENT page', () => {
    ingestDesignVariables(dir, [{ name: 'a', raw: '#000' }], { source: 'other page', pageId: 'Other.tsx' })
    const applicable = resolveApplicableDesignVariableSets(dir, 'Home.tsx', undefined)
    expect(applicable).toHaveLength(0)
  })

  it('includes a set scoped to THIS page, and a set scoped to THIS reference, alongside project-wide', () => {
    ingestDesignVariables(dir, [{ name: 'a', raw: '#000' }], { source: 'project-wide' })
    ingestDesignVariables(dir, [{ name: 'b', raw: '#000' }], { source: 'this page', pageId: 'Home.tsx' })
    ingestDesignVariables(dir, [{ name: 'c', raw: '#000' }], { source: 'other page', pageId: 'Other.tsx' })
    ingestDesignVariables(dir, [{ name: 'd', raw: '#000' }], { source: 'this reference', referenceId: 'ref-1' })
    ingestDesignVariables(dir, [{ name: 'e', raw: '#000' }], { source: 'other reference', referenceId: 'ref-2' })

    const applicable = resolveApplicableDesignVariableSets(dir, 'Home.tsx', 'ref-1')
    const sources = applicable.map((s) => s.source).sort()
    expect(sources).toEqual(['project-wide', 'this page', 'this reference'].sort())
  })

  it('an empty project resolves to an empty list, not an error', () => {
    expect(resolveApplicableDesignVariableSets(dir, 'Home.tsx', undefined)).toEqual([])
  })
})

describe('manifest durability — hostile/corrupted persisted state degrades safely', () => {
  it('a corrupted manifest.json falls back to empty rather than throwing', () => {
    const manifestDir = path.join(dir, '.studio', 'variables')
    fs.mkdirSync(manifestDir, { recursive: true })
    fs.writeFileSync(path.join(manifestDir, 'manifest.json'), '{ this is not valid json')
    expect(listDesignVariableSets(dir, {}, undefined).sets).toEqual([])
    expect(resolveApplicableDesignVariableSets(dir, 'Home.tsx', undefined)).toEqual([])
  })

  it('a manifest with the wrong shape (schema mismatch) also degrades to empty', () => {
    const manifestDir = path.join(dir, '.studio', 'variables')
    fs.mkdirSync(manifestDir, { recursive: true })
    fs.writeFileSync(path.join(manifestDir, 'manifest.json'), JSON.stringify({ version: 1, sets: 'not an array' }))
    expect(listDesignVariableSets(dir, {}, undefined).sets).toEqual([])
  })

  it('ingesting after a corrupted manifest recovers cleanly (does not perpetuate the corruption)', () => {
    const manifestDir = path.join(dir, '.studio', 'variables')
    fs.mkdirSync(manifestDir, { recursive: true })
    fs.writeFileSync(path.join(manifestDir, 'manifest.json'), 'not json at all')
    const { set } = ingestDesignVariables(dir, [{ name: 'a', raw: '#000' }], { source: 'test' })
    expect(getDesignVariableSet(dir, set.id)?.id).toBe(set.id)
  })
})
