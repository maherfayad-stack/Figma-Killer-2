/**
 * Cmd-Z for a style write that landed as an override or an expanded shorthand
 * is the undo journal's `restore`, not "set the old value back" (which
 * invented `padding-top: 20px` on undo of `padding: 20px 10px` + top 30).
 *
 * The entry is inferred from the save, so the inference has to be exact: one
 * new plain entry since the previous save, still the very same entry when the
 * answer arrives.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import type { StyleLanding } from '@core/page-tree'
import { useEditorStore } from '@site/store/store'
import type { HistoryEntry } from '@site/store/slices/site/types'
import { claimNewStyleHistoryEntry, journalStyleBatch } from '../styleWriteJournal'

const TOKEN = 'c'.repeat(32)

function entry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return { inverse: [], forward: [], coalesceKey: null, ...over }
}

function landing(rung: StyleLanding['rung']): StyleLanding {
  return { nodeId: 'css:1', rung, file: 'pages/Home.css' } as StyleLanding
}

const EDITS = [{ kind: 'css', op: 'set', nodeId: 'css:1', file: 'pages/Home.css', selector: '.padded', property: 'padding-top', value: '30px' }]

function stack(...entries: HistoryEntry[]): void {
  useEditorStore.setState({ _historyPast: entries } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(() => stack())

describe('claimNewStyleHistoryEntry', () => {
  it('names the one entry pushed since the last save', () => {
    const settled = entry()
    stack(settled)
    claimNewStyleHistoryEntry([settled])

    const edit = entry()
    expect(claimNewStyleHistoryEntry([settled, edit])).toEqual({ index: 1, entry: edit })
  })

  it('names nothing when the batch holds several entries - one token would take them all back', () => {
    const settled = entry()
    claimNewStyleHistoryEntry([settled])
    expect(claimNewStyleHistoryEntry([settled, entry(), entry()])).toBeNull()
  })

  it('does not count a structural entry a gesture pushed by its own commit', () => {
    const settled = entry()
    claimNewStyleHistoryEntry([settled])
    const structural = entry({
      structural: { gesture: 'source', source: { label: 'Move', forward: [], inverseTemplate: { kind: 'restore-journal' }, inverse: null } },
    })
    const edit = entry()
    expect(claimNewStyleHistoryEntry([settled, structural, edit])).toEqual({ index: 2, entry: edit })
  })

  it('names nothing when the top entry is not a plain edit', () => {
    const settled = entry()
    claimNewStyleHistoryEntry([settled])
    const structural = entry({
      structural: { gesture: 'source', source: { label: 'Move', forward: [], inverseTemplate: { kind: 'restore-journal' }, inverse: null } },
    })
    expect(claimNewStyleHistoryEntry([settled, structural])).toBeNull()
  })

  it('an entry is claimed once: a second save with no new edit claims nothing', () => {
    const settled = entry()
    const edit = entry()
    claimNewStyleHistoryEntry([settled])
    expect(claimNewStyleHistoryEntry([settled, edit])).not.toBeNull()
    expect(claimNewStyleHistoryEntry([settled, edit])).toBeNull()
  })
})

describe('journalStyleBatch', () => {
  function claimed(): { edit: HistoryEntry; target: NonNullable<ReturnType<typeof claimNewStyleHistoryEntry>> } {
    const settled = entry()
    const edit = entry()
    claimNewStyleHistoryEntry([settled])
    const target = claimNewStyleHistoryEntry([settled, edit])!
    stack(settled, edit)
    return { edit, target }
  }

  it('turns the entry into a restore of the journal token for an override', () => {
    const { target } = claimed()
    journalStyleBatch(target, [landing('override')], EDITS, TOKEN)

    const top = useEditorStore.getState()._historyPast.at(-1)
    expect(top?.structural).toEqual({
      gesture: 'source',
      source: {
        label: 'Style change',
        forward: EDITS,
        inverseTemplate: { kind: 'restore-journal' },
        inverse: [{ kind: 'restore', nodeId: `undo-journal:${TOKEN}`, token: TOKEN }],
      },
    })
  })

  it('also for an expanded shorthand', () => {
    const { target } = claimed()
    journalStyleBatch(target, [landing('expanded')], EDITS, TOKEN)
    expect(useEditorStore.getState()._historyPast.at(-1)?.structural).toBeDefined()
  })

  it('leaves an ordinary rule landing on the value-level undo', () => {
    const { target } = claimed()
    journalStyleBatch(target, [landing('rule')], EDITS, TOKEN)
    expect(useEditorStore.getState()._historyPast.at(-1)?.structural).toBeUndefined()
  })

  it('does nothing without a token', () => {
    const { target } = claimed()
    journalStyleBatch(target, [landing('override')], EDITS, undefined)
    expect(useEditorStore.getState()._historyPast.at(-1)?.structural).toBeUndefined()
  })

  it('ignores an entry a later edit has replaced: the token no longer describes it', () => {
    const { target } = claimed()
    const settled = useEditorStore.getState()._historyPast[0]!
    stack(settled, entry())
    journalStyleBatch(target, [landing('override')], EDITS, TOKEN)
    expect(useEditorStore.getState()._historyPast.at(-1)?.structural).toBeUndefined()
  })
})
