/**
 * TokenCatalogProvider — computes the spacing/typography token catalogs
 * ONCE and provides them through `TokenCatalogContext` (`useTokenCatalog()`
 * is how consumers read them). See that file's doc for why this pass
 * exists and why it's split into a `.ts` (context + hook) and this sibling
 * `.tsx` (the Provider component) — React Fast Refresh requires a file to
 * export only components OR only non-components.
 */
import type { ReactNode } from 'react'
import { useSpacingTokens, useTypographyTokens } from './tokenUtils'
import { TokenCatalogContext } from './TokenCatalogContext'

export function TokenCatalogProvider({ children }: { children: ReactNode }) {
  const spacingTokens = useSpacingTokens()
  const typographyTokens = useTypographyTokens()
  return (
    <TokenCatalogContext.Provider value={{ spacingTokens, typographyTokens }}>
      {children}
    </TokenCatalogContext.Provider>
  )
}
