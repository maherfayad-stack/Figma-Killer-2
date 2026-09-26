/**
 * P3-B (WB-3) — the client half of "text inside a container tag is an editable
 * node". An imported `<li>Opening act</li>` arrives as `base.text` with
 * `tag: 'custom', customTag: 'li'`. Its edits must reach the save as exactly
 * the two edit kinds the element's source can honestly take:
 *
 * - a text change → ONE `text` edit at the element (`setJsxText` rewrites its
 *   sole text child), never a `prop` edit that would write `text="…"` onto it;
 * - a tag change → ONE `tag` edit naming the new element, never a junk
 *   `tag="custom"` / `customTag="dt"` attribute.
 *
 * An unchanged node sends nothing at all.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import '@modules/base/text'
import type { Page } from '@core/page-tree'
import { collectNodeDiffEdits } from '../nodeDiffWriteback'
import { resetLoadedValues } from '../loadedValuesBaseline'
import { makeNode, makePage } from '../../../../../__tests__/fixtures'

const ITEM_ID = 'pages/Lineup.tsx:11:10'

function lineup(props: Record<string, unknown>): Page {
  return makePage({
    id: 'lineup',
    rootNodeId: 'lineup:body',
    nodes: {
      'lineup:body': makeNode({ id: 'lineup:body', moduleId: 'base.body', children: [ITEM_ID] }),
      [ITEM_ID]: makeNode({ id: ITEM_ID, moduleId: 'base.text', props }),
    },
  })
}

const LOADED = { text: 'Opening act', tag: 'custom', customTag: 'li', htmlAttributes: {} }

beforeEach(() => {
  resetLoadedValues([lineup(LOADED)])
})

describe('a text node on a custom tag writes back as text and tag edits', () => {
  it('sends nothing for an unchanged node', () => {
    expect(collectNodeDiffEdits([lineup(LOADED)], undefined).edits).toEqual([])
  })

  it('sends a text change as one text edit at the element', () => {
    const { edits } = collectNodeDiffEdits([lineup({ ...LOADED, text: 'Closing act' })], undefined)
    expect(edits).toEqual([{ kind: 'text', nodeId: ITEM_ID, text: 'Closing act' }])
  })

  it('sends a custom tag change as one tag edit naming the real element', () => {
    const { edits } = collectNodeDiffEdits([lineup({ ...LOADED, customTag: 'dt' })], undefined)
    expect(edits).toEqual([{ kind: 'tag', nodeId: ITEM_ID, tag: 'dt' }])
  })

  it('sends a switch to a named tag as the named tag', () => {
    const { edits } = collectNodeDiffEdits([lineup({ ...LOADED, tag: 'h3' })], undefined)
    expect(edits).toEqual([{ kind: 'tag', nodeId: ITEM_ID, tag: 'h3' }])
  })
})
