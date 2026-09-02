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

/** Mirrors `server/handlers/studio.ts`'s real §4.2 resolver, for the promotion tests below. */
function resolveModuleIdWithChildren({
  kind,
  name,
  children,
}: {
  kind: 'element' | 'component'
  name: string
  children: string[]
}): string {
  if (kind === 'component') return `alm.${name}`
  const tag = name.toLowerCase()
  if (['div', 'section', 'main', 'header', 'footer', 'nav', 'article', 'aside'].includes(tag)) {
    return 'base.container'
  }
  if (tag === 'button') return 'base.button'
  if (tag === 'a') return 'base.link'
  if (tag === 'img') return 'base.image'
  if (tag === 'svg') return 'base.svg'
  if (children.length > 0) return 'base.container'
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

/** Mirrors `server/handlers/studio.ts`'s real §4.2 `resolveTextProp`. */
function resolveTextPropReal(moduleId: string): string | null {
  switch (moduleId) {
    case 'base.text':
      return 'text'
    case 'base.button':
      return 'label'
    case 'base.link':
      return 'text'
    default:
      return null
  }
}

test('§4.4 non-regression: a text-only <p>Hello</p> still resolves to base.text with props.text', () => {
  const P_ID = 'Home.tsx:11:4'
  const textOnlyParsed: ParsedPage = {
    rootIds: [P_ID],
    nodes: {
      [P_ID]: {
        id: P_ID,
        kind: 'element',
        name: 'p',
        props: {},
        children: [],
        loc: { file: 'Home.tsx', line: 11, col: 4 },
        locked: false,
        text: 'Hello',
      },
    },
  }

  const result = parsedPageToSitePage(textOnlyParsed, {
    pageId: 'home',
    slug: 'home',
    title: 'Home',
    resolveModuleId: resolveModuleIdWithChildren,
    resolveTextProp: resolveTextPropReal,
  })

  const pNode = result.nodes[P_ID]
  expect(pNode.moduleId).toBe('base.text')
  expect(pNode.props.text).toBe('Hello')
  // A base.text leaf carries no promoted-container tag props.
  expect(pNode.props.tag).toBeUndefined()
  expect(pNode.props.customTag).toBeUndefined()
})

test('§4 promotion: a <p> wrapping an element child resolves to base.container, not base.text', () => {
  const ICON_ID = 'Home.tsx:13:6'
  const P_ID = 'Home.tsx:12:4'
  const promotedParsed: ParsedPage = {
    rootIds: [P_ID],
    nodes: {
      [P_ID]: {
        id: P_ID,
        kind: 'element',
        name: 'p',
        props: {},
        children: [ICON_ID],
        loc: { file: 'Home.tsx', line: 12, col: 4 },
        locked: false,
      },
      [ICON_ID]: {
        id: ICON_ID,
        kind: 'component',
        name: 'Icon',
        props: {},
        children: [],
        loc: { file: 'Home.tsx', line: 13, col: 6 },
        locked: false,
      },
    },
  }

  const result = parsedPageToSitePage(promotedParsed, {
    pageId: 'home',
    slug: 'home',
    title: 'Home',
    resolveModuleId: resolveModuleIdWithChildren,
    resolveTextProp: resolveTextPropReal,
  })

  const pNode = result.nodes[P_ID]
  // Promoted, not the base.text leaf, or the Icon child would be dropped.
  expect(pNode.moduleId).toBe('base.container')
  expect(pNode.children).toEqual([ICON_ID])
  // The promoted node still carries its real host tag so it doesn't render
  // as a bare <div> — base.container's `tag` control's built-in list does not
  // include 'p', so it goes through the 'custom' escape hatch.
  expect(pNode.props.tag).toBe('custom')
  expect(pNode.props.customTag).toBe('p')
})

test('§4.3: a promoted <ul> carries its tag via the built-in select option, not the custom escape hatch', () => {
  const ICON_ID = 'Home.tsx:15:8'
  const UL_ID = 'Home.tsx:14:4'
  // 'ul' is a genuinely built-in choice per `htmlTagControl()`'s options, but
  // was NOT in the server's old hardcoded 8-tag container list — it only
  // becomes `base.container` via the new children-based promotion rule. It
  // should still land on the plain `props.tag` form, not the 'custom' escape
  // hatch used for tags outside the built-in list (covered by the <p> test
  // above).
  const ulParsed: ParsedPage = {
    rootIds: [UL_ID],
    nodes: {
      [UL_ID]: {
        id: UL_ID,
        kind: 'element',
        name: 'ul',
        props: {},
        children: [ICON_ID],
        loc: { file: 'Home.tsx', line: 14, col: 4 },
        locked: false,
      },
      [ICON_ID]: {
        id: ICON_ID,
        kind: 'component',
        name: 'Icon',
        props: {},
        children: [],
        loc: { file: 'Home.tsx', line: 15, col: 8 },
        locked: false,
      },
    },
  }

  const result = parsedPageToSitePage(ulParsed, {
    pageId: 'home',
    slug: 'home',
    title: 'Home',
    resolveModuleId: resolveModuleIdWithChildren,
    resolveTextProp: resolveTextPropReal,
  })

  const ulNode = result.nodes[UL_ID]
  expect(ulNode.moduleId).toBe('base.container')
  expect(ulNode.props.tag).toBe('ul')
  expect(ulNode.props.customTag).toBeUndefined()
})

// ---------------------------------------------------------------------------
// base.svg host tag — `<span dangerouslySetInnerHTML={{__html: rawIcon}} />`,
// the shape every repo uses to inline a `?raw` icon. The span is the AUTHOR's:
// its class carries the icon's box (`.icon { width: 24px }`, paired with
// `.icon svg { width: 100% }`). Losing which element the source actually wrote
// is what made the module substitute a box-less host and render every icon at
// its flex container's width.
// ---------------------------------------------------------------------------

/** Mirrors `studioPageLoad.ts`'s real resolver for the two ways `base.svg` is reached. */
function resolveModuleIdWithRawSvg({
  kind,
  name,
  props,
}: {
  kind: 'element' | 'component'
  name: string
  props?: Record<string, unknown>
}): string {
  if (kind === 'component') return `alm.${name}`
  if (typeof props?.svg === 'string' && props.svg.length > 0) return 'base.svg'
  if (name.toLowerCase() === 'svg') return 'base.svg'
  return 'base.container'
}

function svgPage(name: string, props: Record<string, unknown>): ParsedPage {
  const id = 'Home.tsx:20:6'
  return {
    rootIds: [id],
    nodes: {
      [id]: {
        id,
        kind: 'element',
        name,
        props,
        children: [],
        loc: { file: 'Home.tsx', line: 20, col: 6 },
        locked: false,
      },
    },
  }
}

function svgNodeProps(name: string, props: Record<string, unknown>) {
  const result = parsedPageToSitePage(svgPage(name, props), {
    pageId: 'home',
    slug: 'home',
    title: 'Home',
    resolveModuleId: resolveModuleIdWithRawSvg,
    resolveTextProp: resolveTextPropReal,
    resolveClassIds: (className) => className.split(/\s+/).filter(Boolean),
  })
  return result.nodes['Home.tsx:20:6']
}

test('parsedPageToSitePage records the authored host element of an inlined raw icon', () => {
  const node = svgNodeProps('span', { svg: '<svg><path d="M0 0"/></svg>', className: 'icon' })
  expect(node.moduleId).toBe('base.svg')
  expect(node.props.tag).toBe('span')
  // The class is still translated to classIds — it is what sizes the icon.
  expect(node.classIds).toContain('icon')
})

test('parsedPageToSitePage records no host element for a bare <svg>', () => {
  const node = svgNodeProps('svg', { svg: '<svg><path d="M0 0"/></svg>' })
  expect(node.moduleId).toBe('base.svg')
  expect(node.props.tag).toBeUndefined()
})
