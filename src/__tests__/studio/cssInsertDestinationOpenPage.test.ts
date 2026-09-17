/**
 * Z8 — the open page as a CSS insert destination's anchor of last resort, and
 * the user's own answer to an ambiguity.
 *
 * `resolveCssInsertDestination` used to refuse a class that is on no element
 * yet with the words "this class has no page to co-locate a new one with",
 * because the module "has no notion of which page is open". That is the
 * ordinary way to make a class — the Selectors panel's "create class", with
 * nothing selected — so in a project whose pages each own a stylesheet, every
 * new class refused, and in a project with none, no stylesheet was ever
 * created.
 *
 * ## The shapes this file deliberately does NOT share with the corpus
 *
 * Every earlier destination test in this folder is written against
 * `pages/Home.tsx` + `pages/Home.module.css` — the convention Studio's own
 * scaffold writes, and the convention of the one imported project this
 * feature was reported from. A suite grown from one repo encodes that repo's
 * habits, so the anchor is pinned here against three unrelated layouts:
 * `src/screens/Dashboard.jsx` + a plain sibling `.css`, a flat
 * `app/pricing.tsx`, and a Next App Router route whose tree also carries
 * `layout.tsx` nodes. The last one is the one that matters most — an anchor
 * that answered `layout.tsx` would co-locate a stylesheet with a file EVERY
 * route composes, which is the "N places the user didn't ask for" failure one
 * level up.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import type { Page, PageNode, StyleRule } from '@core/page-tree'
import {
  pinCssInsertDestination,
  resolveCssInsertDestination,
  resolveOpenPageFile,
  setOpenPageFile,
  setStudioStyleRuleSources,
} from '@site/studio/styleRuleWriteback'

const NEW_RULE_ID = 'nanoid-brand-new'

/** A class the user just created in the Selectors panel: editor-authored id, no `scope`, on no element. */
function freestandingRule(overrides: Partial<StyleRule> = {}): StyleRule {
  return {
    id: NEW_RULE_ID,
    kind: 'class',
    name: 'promo-banner',
    selector: '.promo-banner',
    styles: {},
    contextStyles: {},
    order: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as StyleRule
}

function node(id: string, children: string[] = []): PageNode {
  return { id, moduleId: 'base.container', props: {}, children, classIds: [], breakpointOverrides: {} }
}

/** A board page as `parsedPageToSitePage` builds one: a synthetic `<pageId>:body` root over source-derived nodes. */
function page(id: string, nodeIds: readonly string[]): Page {
  const root = `${id}:body`
  const nodes: Record<string, PageNode> = { [root]: node(root, [...nodeIds]) }
  for (const nodeId of nodeIds) nodes[nodeId] = node(nodeId)
  return { id, slug: id, title: id, rootNodeId: root, nodes } as Page
}

beforeEach(() => {
  setStudioStyleRuleSources({}, {})
  setOpenPageFile(null)
})

describe('resolveOpenPageFile — which file the open page actually is', () => {
  it('answers the one file every node on the page traces its call site to', () => {
    const pages = [page('dashboard', ['src/screens/Dashboard.jsx:8:3', 'src/screens/Dashboard.jsx:12:7'])]
    expect(resolveOpenPageFile(pages, 'dashboard')).toBe('src/screens/Dashboard.jsx')
  })

  it('reads the CALL SITE of an inlined node, not the component it was inlined from', () => {
    // `app/pricing.tsx:4:1~src/components/PriceCard.jsx:2:1` — the markup lives
    // in PriceCard, but the PAGE is `app/pricing.tsx`, and a new stylesheet
    // belongs beside the page, not beside a component every page may use.
    const pages = [page('pricing', ['app/pricing.tsx:4:1~src/components/PriceCard.jsx:2:1'])]
    expect(resolveOpenPageFile(pages, 'pricing')).toBe('app/pricing.tsx')
  })

  it('skips Next route chrome — a layout is composed into every route, so it is nobody’s page', () => {
    const pages = [
      page('shop', ['app/layout.tsx:9:5', 'app/shop/layout.tsx:3:1', 'app/shop/page.tsx:11:3']),
    ]
    expect(resolveOpenPageFile(pages, 'shop')).toBe('app/shop/page.tsx')
  })

  it('ignores the synthetic root and .map rows, which name no single source location', () => {
    const pages = [page('feed', ['src/Feed.tsx:20:4', 'src/Feed.tsx:24:9#0', 'src/Feed.tsx:24:9#1'])]
    expect(resolveOpenPageFile(pages, 'feed')).toBe('src/Feed.tsx')
  })

  it('answers null when the page’s own nodes disagree on a file — never the first one seen', () => {
    // Two non-chrome files in one tree is not something to break a tie on: an
    // anchor that guessed here would write into a file the user never named.
    const pages = [page('mixed', ['src/A.tsx:1:1', 'src/B.tsx:1:1'])]
    expect(resolveOpenPageFile(pages, 'mixed')).toBeNull()
  })

  it('answers null for no page open, an unknown id, and a page with no source at all', () => {
    const pages = [page('home', ['src/Home.tsx:1:1'])]
    expect(resolveOpenPageFile(pages, null)).toBeNull()
    expect(resolveOpenPageFile(pages, 'nope')).toBeNull()
    expect(resolveOpenPageFile([page('blank', [])], 'blank')).toBeNull()
  })
})

describe('resolveCssInsertDestination — the open page as the anchor of last resort', () => {
  it('writes into the stylesheet co-located with the OPEN page when two exist and the class names neither', () => {
    setStudioStyleRuleSources(
      {
        a: { file: 'src/screens/Dashboard.css', selector: '.a' },
        b: { file: 'src/screens/Settings.css', selector: '.b' },
      },
      {},
    )
    setOpenPageFile('src/screens/Dashboard.jsx')

    expect(resolveCssInsertDestination(freestandingRule())).toEqual({
      ok: true,
      kind: 'existing',
      file: 'src/screens/Dashboard.css',
    })
  })

  it('creates a co-located stylesheet for the open page when the project has none at all', () => {
    setOpenPageFile('src/screens/Dashboard.jsx')

    expect(resolveCssInsertDestination(freestandingRule())).toEqual({
      ok: true,
      kind: 'create',
      pageFile: 'src/screens/Dashboard.jsx',
    })
  })

  it('is a FALLBACK — the class’s own page still wins over the page on screen', () => {
    setStudioStyleRuleSources(
      {
        a: { file: 'src/screens/Dashboard.css', selector: '.a' },
        b: { file: 'src/screens/Settings.css', selector: '.b' },
      },
      {},
    )
    setOpenPageFile('src/screens/Dashboard.jsx')
    // The class IS used, on Settings. Following the board to Dashboard would
    // move an existing class's declarations into a file its elements do not
    // import — the anchor exists for classes with no page, not to override one.
    const usedOnSettings = new Map([[NEW_RULE_ID, 'src/screens/Settings.jsx']])

    expect(resolveCssInsertDestination(freestandingRule(), usedOnSettings)).toMatchObject({
      file: 'src/screens/Settings.css',
    })
  })

  it('still refuses ambiguity when the open page has no stylesheet of its own', () => {
    setStudioStyleRuleSources(
      {
        a: { file: 'src/screens/Dashboard.css', selector: '.a' },
        b: { file: 'src/screens/Settings.css', selector: '.b' },
      },
      {},
    )
    // The open page is a THIRD screen Studio has never seen a stylesheet for.
    // The anchor is not a licence to pick any file — two real choices remain
    // and the user is the only one who can make that call.
    setOpenPageFile('src/screens/Billing.jsx')

    const result = resolveCssInsertDestination(freestandingRule())
    expect(result).toMatchObject({ ok: false, reason: 'ambiguous-stylesheet' })
    expect(result.ok === false && result.candidates).toEqual([
      'src/screens/Dashboard.css',
      'src/screens/Settings.css',
    ])
  })

  it('keeps the terminal refusal when nothing — not even the board — names a page', () => {
    // The one path left to `no-editable-stylesheet`: zero stylesheets, no
    // class page, and a board showing a page with no resolvable source file.
    const result = resolveCssInsertDestination(freestandingRule())
    expect(result).toMatchObject({ ok: false, reason: 'no-editable-stylesheet' })
    expect(result.ok === false && result.candidates).toEqual([])
  })
})

describe('pinCssInsertDestination — the user’s answer to an ambiguity', () => {
  beforeEach(() => {
    setStudioStyleRuleSources(
      {
        a: { file: 'src/styles/base.css', selector: '.a' },
        b: { file: 'src/styles/marketing.css', selector: '.b' },
      },
      {},
    )
  })

  it('turns the refusal into a resolved destination for that rule only', () => {
    expect(resolveCssInsertDestination(freestandingRule())).toMatchObject({ reason: 'ambiguous-stylesheet' })

    pinCssInsertDestination(NEW_RULE_ID, 'src/styles/marketing.css')

    expect(resolveCssInsertDestination(freestandingRule())).toEqual({
      ok: true,
      kind: 'existing',
      file: 'src/styles/marketing.css',
    })
    // A different rule was not answered, so it still asks.
    const other = freestandingRule({ id: 'nanoid-other', selector: '.other' })
    expect(resolveCssInsertDestination(other)).toMatchObject({ reason: 'ambiguous-stylesheet' })
  })

  it('outranks the open page — an answer the user gave is not a heuristic to be beaten', () => {
    setOpenPageFile('src/styles/base.tsx')
    pinCssInsertDestination(NEW_RULE_ID, 'src/styles/marketing.css')

    expect(resolveCssInsertDestination(freestandingRule())).toMatchObject({ file: 'src/styles/marketing.css' })
  })

  it('is ignored once the file it names is no longer a stylesheet this project writes to', () => {
    pinCssInsertDestination(NEW_RULE_ID, 'src/styles/marketing.css')
    // A reload against a project that no longer has that file: the pin is a
    // decision about a world that is gone, so the refusal comes back rather
    // than a write landing somewhere unverifiable.
    setStudioStyleRuleSources(
      { a: { file: 'src/styles/base.css', selector: '.a' }, c: { file: 'src/styles/app.css', selector: '.c' } },
      {},
    )

    expect(resolveCssInsertDestination(freestandingRule())).toMatchObject({ reason: 'ambiguous-stylesheet' })
  })

  it('does not survive a fresh load', () => {
    pinCssInsertDestination(NEW_RULE_ID, 'src/styles/marketing.css')
    setStudioStyleRuleSources(
      {
        a: { file: 'src/styles/base.css', selector: '.a' },
        b: { file: 'src/styles/marketing.css', selector: '.b' },
      },
      {},
    )

    expect(resolveCssInsertDestination(freestandingRule())).toMatchObject({ reason: 'ambiguous-stylesheet' })
  })
})
