/**
 * TokenCatalogContext — perf-01.
 *
 * `ClassPropertyRow` used to call `useSpacingTokens`/`useTypographyTokens`
 * itself, so the properties panel's ~101 curated rows each independently
 * subscribed to the store and rebuilt a `Token[]` from scratch. This file
 * proves the structural fix: every row consuming `useTokenCatalog()` gets
 * the SAME array reference from a single `TokenCatalogProvider`, computed
 * once — not one independently-built array per row.
 */

import { describe, it, expect, afterEach } from 'bun:test'
import { render, cleanup, act } from '@testing-library/react'
import { useTokenCatalog } from '@site/property-controls/TokenCatalogContext'
import { TokenCatalogProvider } from '@site/property-controls/TokenCatalogProvider'
import { useEditorStore } from '@site/store/store'
import { makeSite } from '../fixtures'

afterEach(cleanup)

function seedTokens() {
  useEditorStore.setState({
    site: makeSite({
      settings: {
        shortcuts: {},
        framework: {
          spacing: {
            groups: [
              {
                id: 'group-space',
                name: 'Spacing',
                namingConvention: 'space',
                min: { size: 16, scaleRatio: 1.25 },
                max: { size: 28, scaleRatio: 1.414 },
                steps: 'sm,md,lg',
                baseScaleIndex: 1,
                mode: 'fluid',
                order: 0,
                createdAt: 0,
                updatedAt: 0,
              },
            ],
          },
        },
      },
    }),
  } as Parameters<typeof useEditorStore.setState>[0])
}

describe('TokenCatalogProvider / useTokenCatalog', () => {
  it('gives every consumer the SAME array reference — one computation, not one per row', () => {
    seedTokens()

    const seen: Array<ReturnType<typeof useTokenCatalog>> = []
    function Row() {
      seen.push(useTokenCatalog())
      return null
    }

    render(
      <TokenCatalogProvider>
        {/* Stand-in for the properties panel's ~101 `ClassPropertyRow`s —
            10 is enough to prove sharing without a slow test. */}
        {Array.from({ length: 10 }, (_, i) => (
          <Row key={i} />
        ))}
      </TokenCatalogProvider>,
    )

    expect(seen).toHaveLength(10)
    expect(seen[0].spacingTokens.length).toBeGreaterThan(0)
    for (const catalog of seen) {
      expect(catalog.spacingTokens).toBe(seen[0].spacingTokens)
      expect(catalog.typographyTokens).toBe(seen[0].typographyTokens)
    }
  })

  it('falls back to empty catalogs outside a provider, instead of subscribing on its own', () => {
    seedTokens()

    const seen: Array<ReturnType<typeof useTokenCatalog>> = []
    function Bare() {
      seen.push(useTokenCatalog())
      return null
    }

    render(<Bare />)

    const observed = seen.at(-1)
    expect(observed).not.toBeUndefined()
    expect(observed!.spacingTokens).toEqual([])
    expect(observed!.typographyTokens).toEqual([])
  })

  it('updates every consumer together when framework settings actually change (no staleness)', () => {
    seedTokens()

    const seen: Array<ReturnType<typeof useTokenCatalog>> = []
    function Row() {
      seen.push(useTokenCatalog())
      return null
    }

    const { rerender } = render(
      <TokenCatalogProvider>
        <Row />
      </TokenCatalogProvider>,
    )
    const before = seen.at(-1)!.spacingTokens
    expect(before.map((t) => t.step)).toEqual(['sm', 'md', 'lg'])

    act(() => {
      useEditorStore.setState((state) => {
        const groups = state.site!.settings.framework!.spacing!.groups
        groups[0].steps = 'sm,md,lg,xl'
      })
    })
    rerender(
      <TokenCatalogProvider>
        <Row />
      </TokenCatalogProvider>,
    )

    const after = seen.at(-1)!.spacingTokens
    expect(after).not.toBe(before)
    expect(after.map((t) => t.step)).toEqual(['sm', 'md', 'lg', 'xl'])
  })
})
