/**
 * ERR-9's rebase must never carry a value across LITERALS — the 2026-09-30
 * "Arabic written into `en`" report.
 *
 * `test4` keeps both locales in ONE module (`i18n/translations.ts`: `en` and
 * `ar` branches). A node on the `ar`-previewed board resolves its text from
 * the `ar` literal; the same node re-read under `en` resolves it from the `en`
 * literal — same file, different line. The rebase used to compare only the
 * FILE of the two origins, so an `ar` value the store held as "unsaved" was
 * carried onto the fresh `en` node, and the next autosave wrote it at the `en`
 * literal. Exactly the keys whose `en` text equalled the old `ar` text got
 * polluted (`_941Am`, `goodNewsAFewHotels`, `sMS.label`), which is what the
 * forensic diff showed.
 */
import { describe, expect, it } from 'bun:test'
import type { Page, PageNode } from '@core/page-tree'
import type { BaselineBeforeRead } from '@site/studio/loadedValuesBaseline'
import { rebaseUnsavedEdits } from '@site/store/slices/site/unsavedEditRebase'
import { makeNode, makePage } from '../fixtures'
import '@modules/base/index'

const EN_ORIGIN = { rel: 'i18n/translations.ts', line: 24, col: 15 }
const AR_ORIGIN = { rel: 'i18n/translations.ts', line: 83, col: 15 }
const NODE_ID = 'components/OnboardingHero.tsx:30:14'

/** The shape `parsedPageToSitePage` gives a text resolved from a dictionary: code-valued, traced to one literal. */
function page(text: string, origin: NonNullable<PageNode['textOrigin']>): Page {
  const node = makeNode({
    id: NODE_ID,
    moduleId: 'base.text',
    props: { text },
    codeProps: ['text'],
    resolvedProps: { text: { source: 't.onboardingHero._941Am', origin } },
    textOrigin: origin,
  })
  const root = makeNode({ id: 'onboarding:body', moduleId: 'base.body', children: [NODE_ID] })
  return makePage({ id: 'onboarding', rootNodeId: root.id, nodes: { [root.id]: root, [NODE_ID]: node } })
}

function baseline(text: string): BaselineBeforeRead {
  return { values: (nodeId) => (nodeId === NODE_ID ? { text } : undefined), classIds: () => undefined }
}

describe('a rebase never moves a value from one dictionary literal to another', () => {
  it('an ar-resolved value is NOT carried onto the fresh en node, even though both live in one file', () => {
    // Before the re-read: the board shows the new `ar` translation, the save
    // baseline says `9:41 ص` (the old text, which `en` also held).
    const current = page('9:41 صباحًا', AR_ORIGIN)
    const fresh = page('9:41 ص', EN_ORIGIN)

    const result = rebaseUnsavedEdits([current], [fresh], baseline('9:41 ص'))

    expect(result.pages[0]!.nodes[NODE_ID]!.props.text).toBe('9:41 ص')
    expect(result.rebasedPageIds.size).toBe(0)
    expect(result.lost).toEqual([expect.objectContaining({ nodeId: NODE_ID, reason: 'source-changed' })])
  })

  it('an unsaved edit at the SAME literal is still carried (the ERR-9 behaviour is kept)', () => {
    const current = page('9:41 AM', EN_ORIGIN)
    const fresh = page('9:41', EN_ORIGIN)

    const result = rebaseUnsavedEdits([current], [fresh], baseline('9:41'))

    expect(result.pages[0]!.nodes[NODE_ID]!.props.text).toBe('9:41 AM')
    expect(result.rebasedPageIds.has('onboarding')).toBe(true)
    expect(result.lost).toEqual([])
  })
})
