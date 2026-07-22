import { expect, test } from 'bun:test'
import type { ParsedPage } from '../../page-parser'
import { parsePage } from '../../page-tree'
import { parsedPageToSitePage } from '../parsedPageToSitePage'

const DIV_ID = 'Home.tsx:5:8'
const BUTTON_ID = 'Home.tsx:6:10'

const parsed: ParsedPage = {
  rootIds: [DIV_ID],
  nodes: {
    [DIV_ID]: {
      id: DIV_ID,
      kind: 'element',
      name: 'div',
      props: {},
      children: [BUTTON_ID],
      loc: { file: 'Home.tsx', line: 5, col: 8 },
      locked: false,
    },
    [BUTTON_ID]: {
      id: BUTTON_ID,
      kind: 'component',
      name: 'Button',
      props: { label: 'Save', variant: 'primary' },
      children: [],
      loc: { file: 'Home.tsx', line: 6, col: 10 },
      locked: false,
    },
  },
}

function resolveModuleId({ kind, name }: { kind: 'element' | 'component'; name: string }): string {
  if (kind === 'component') return `alm.${name}`
  if (name === 'div') return 'base.container'
  return 'base.text'
}

/** No text prop known for any module id in these base tests, unless overridden per-test. */
function resolveTextProp(): string | null {
  return null
}

test('parsedPageToSitePage wraps parsed roots under a synthetic base.body node', () => {
  const result = parsedPageToSitePage(parsed, {
    pageId: 'home',
    slug: 'home',
    title: 'Home',
    resolveModuleId,
    resolveTextProp,
  })

  const bodyId = 'home:body'
  expect(result.rootNodeId).toBe(bodyId)

  const bodyNode = result.nodes[bodyId]
  expect(bodyNode.moduleId).toBe('base.body')
  expect(bodyNode.children).toEqual(parsed.rootIds)

  const divNode = result.nodes[DIV_ID]
  expect(divNode.moduleId).toBe('base.container')
  expect(divNode.children).toEqual([BUTTON_ID])

  const buttonNode = result.nodes[BUTTON_ID]
  expect(buttonNode.moduleId).toBe('alm.Button')
  expect(buttonNode.props).toEqual({ label: 'Save', variant: 'primary' })

  expect(Object.keys(result.nodes).length).toBe(3)

  expect(() => parsePage(result, 0)).not.toThrow()
})

test('parsedPageToSitePage propagates locked + lockReason from a locked ParsedNode', () => {
  const LOCKED_ID = 'Home.tsx:7:12'
  const lockedParsed: ParsedPage = {
    rootIds: [DIV_ID],
    nodes: {
      ...parsed.nodes,
      [DIV_ID]: {
        ...parsed.nodes[DIV_ID]!,
        children: [BUTTON_ID, LOCKED_ID],
      },
      [LOCKED_ID]: {
        id: LOCKED_ID,
        kind: 'component',
        name: 'Card',
        props: {},
        children: [],
        loc: { file: 'Home.tsx', line: 7, col: 12 },
        locked: true,
        lockReason: 'rendered inside a .map(...) callback',
      },
    },
  }

  const result = parsedPageToSitePage(lockedParsed, {
    pageId: 'home',
    slug: 'home',
    title: 'Home',
    resolveModuleId,
    resolveTextProp,
  })

  const lockedNode = result.nodes[LOCKED_ID]
  expect(lockedNode.locked).toBe(true)
  expect(lockedNode.lockReason).toBe('rendered inside a .map(...) callback')

  // An unlocked parsed node carries neither field.
  const buttonNode = result.nodes[BUTTON_ID]
  expect(buttonNode.locked).toBeUndefined()
  expect(buttonNode.lockReason).toBeUndefined()
})

test('parsedPageToSitePage handles an empty page', () => {
  const empty: ParsedPage = { rootIds: [], nodes: {} }
  const result = parsedPageToSitePage(empty, {
    pageId: 'blank',
    slug: 'blank',
    title: 'Blank',
    resolveModuleId,
    resolveTextProp,
  })

  expect(result.rootNodeId).toBe('blank:body')
  expect(result.nodes['blank:body'].children).toEqual([])
  expect(Object.keys(result.nodes).length).toBe(1)
  expect(() => parsePage(result, 0)).not.toThrow()
})

test('parsedPageToSitePage maps captured text onto the module\'s declared text prop', () => {
  const TEXT_ID = 'Home.tsx:8:4'
  const textParsed: ParsedPage = {
    rootIds: [TEXT_ID],
    nodes: {
      [TEXT_ID]: {
        id: TEXT_ID,
        kind: 'component',
        name: 'Button',
        props: {},
        children: [],
        loc: { file: 'Home.tsx', line: 8, col: 4 },
        locked: false,
        text: 'Click me',
      },
    },
  }

  const resolveTextPropForButton = (moduleId: string): string | null =>
    moduleId === 'alm.Button' ? 'label' : null

  const result = parsedPageToSitePage(textParsed, {
    pageId: 'home',
    slug: 'home',
    title: 'Home',
    resolveModuleId,
    resolveTextProp: resolveTextPropForButton,
  })

  expect(result.nodes[TEXT_ID].props.label).toBe('Click me')
})

test('parsedPageToSitePage prefers an explicit attribute over captured text for the same prop', () => {
  const TEXT_ID = 'Home.tsx:9:4'
  const textParsed: ParsedPage = {
    rootIds: [TEXT_ID],
    nodes: {
      [TEXT_ID]: {
        id: TEXT_ID,
        kind: 'component',
        name: 'Button',
        props: { label: 'FromAttribute' },
        children: [],
        loc: { file: 'Home.tsx', line: 9, col: 4 },
        locked: false,
        text: 'FromChildText',
      },
    },
  }

  const resolveTextPropForButton = (moduleId: string): string | null =>
    moduleId === 'alm.Button' ? 'label' : null

  const result = parsedPageToSitePage(textParsed, {
    pageId: 'home',
    slug: 'home',
    title: 'Home',
    resolveModuleId,
    resolveTextProp: resolveTextPropForButton,
  })

  expect(result.nodes[TEXT_ID].props.label).toBe('FromAttribute')
})

test('parsedPageToSitePage leaves props untouched when resolveTextProp returns null', () => {
  const TEXT_ID = 'Home.tsx:10:4'
  const textParsed: ParsedPage = {
    rootIds: [TEXT_ID],
    nodes: {
      [TEXT_ID]: {
        id: TEXT_ID,
        kind: 'component',
        name: 'Chip',
        props: {},
        children: [],
        loc: { file: 'Home.tsx', line: 10, col: 4 },
        locked: false,
        text: 'New',
      },
    },
  }

  const result = parsedPageToSitePage(textParsed, {
    pageId: 'home',
    slug: 'home',
    title: 'Home',
    resolveModuleId,
    resolveTextProp,
  })

  expect(result.nodes[TEXT_ID].props).toEqual({})
})
