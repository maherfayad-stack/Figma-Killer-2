/**
 * liveNodeResolve — unit tests.
 *
 * live-17's regression case: a design-system component instance's live DOM,
 * once `idStamp.ts` stamps its call site AND unshifts the host element's own
 * internal stamp (so a forwarded `{...props}` spread wins — see `idStamp.ts`'s
 * header), must resolve to the CALL SITE / instance node, never to the
 * nearest stamped ANCESTOR (`main`) the way it did before the fix.
 */
import { describe, expect, it } from 'bun:test'
import { buildStampIndex, resolveLiveNode, type LiveElementLike } from '../liveNodeResolve'

/** A minimal, hand-built `LiveElementLike` tree — no real DOM needed. */
class FakeElement implements LiveElementLike {
  constructor(
    private readonly attrs: Record<string, string>,
    public readonly parentElement: LiveElementLike | null,
  ) {}
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null
  }
}

describe('resolveLiveNode', () => {
  it('live-17: a design-system button instance resolves to itself, not to the page-main ancestor', () => {
    // Before the fix: `idStamp.ts` never stamped the `<Button/>` call site, so
    // the live `<button>` carried only `Button.jsx`'s own internal id — which
    // has no entry in the tree at all — and `resolveLiveNode` fell back to the
    // nearest stamped ANCESTOR, `main`.
    //
    // After the fix: the call site IS stamped, and the host `<button>`'s own
    // internal stamp is unshifted so the forwarded call-site stamp (inside
    // `{...props}`) wins — so the live DOM's `<button>` now carries the
    // instance's OWN id directly.
    const main = new FakeElement({ 'data-node-id': 'pages/SMS.tsx:10:5' }, null)
    const button = new FakeElement({ 'data-node-id': 'pages/SMS.tsx:12:7' }, main)

    const index = buildStampIndex(['pages/SMS.tsx:10:5', 'pages/SMS.tsx:12:7'])
    const occurrencesOf = (stampId: string): readonly LiveElementLike[] => {
      if (stampId === 'pages/SMS.tsx:10:5') return [main]
      if (stampId === 'pages/SMS.tsx:12:7') return [button]
      return []
    }

    const match = resolveLiveNode(button, { index, occurrencesOf })
    expect(match).toEqual({ nodeId: 'pages/SMS.tsx:12:7', exact: true })
  })

  it('falls back to the nearest stamped ancestor when the clicked element itself carries no stamp (vendor/package-internal markup)', () => {
    const main = new FakeElement({ 'data-node-id': 'pages/SMS.tsx:10:5' }, null)
    const unstamped = new FakeElement({}, main)

    const index = buildStampIndex(['pages/SMS.tsx:10:5'])
    const occurrencesOf = (stampId: string): readonly LiveElementLike[] =>
      stampId === 'pages/SMS.tsx:10:5' ? [main] : []

    const match = resolveLiveNode(unstamped, { index, occurrencesOf })
    expect(match).toEqual({ nodeId: 'pages/SMS.tsx:10:5', exact: false })
  })

  it('returns null when neither the element nor any ancestor carries a stamp at all', () => {
    const root = new FakeElement({}, null)
    const child = new FakeElement({}, root)

    const match = resolveLiveNode(child, { index: buildStampIndex([]), occurrencesOf: () => [] })
    expect(match).toBeNull()
  })

  it('pairs a `.map` row by occurrence index among elements sharing one stamp', () => {
    const row0 = new FakeElement({ 'data-node-id': 'pages/List.tsx:5:9' }, null)
    const row1 = new FakeElement({ 'data-node-id': 'pages/List.tsx:5:9' }, null)
    const row2 = new FakeElement({ 'data-node-id': 'pages/List.tsx:5:9' }, null)

    const index = buildStampIndex(['pages/List.tsx:5:9#0', 'pages/List.tsx:5:9#1', 'pages/List.tsx:5:9#2'])
    const occurrencesOf = (): readonly LiveElementLike[] => [row0, row1, row2]

    expect(resolveLiveNode(row1, { index, occurrencesOf })).toEqual({ nodeId: 'pages/List.tsx:5:9#1', exact: true })
  })
})
