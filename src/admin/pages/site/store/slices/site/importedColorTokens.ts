import { nanoid } from 'nanoid'
import type { Draft } from 'mutative'
import { normalizeFrameworkColorSlug } from '@core/framework'
import type { FrameworkColorToken } from '@core/framework-schema'
import type { SiteDocument } from '@core/page-tree'
import type { ImportColorToken } from '@core/siteImport'

/**
 * Merge imported colour tokens into `site.settings.framework.colors` as PLAIN
 * BASE tokens. Each emits only `--<slug>`, so source `var(--<slug>)` references
 * keep resolving without generated utility classes or derived colour variants.
 */
export function addImportedColorTokens(
  site: Draft<SiteDocument>,
  colors: ImportColorToken[],
): { slug: string; value: string }[] {
  if (colors.length === 0) return []

  site.settings.framework ??= { colors: { tokens: [] } }
  site.settings.framework.colors ??= { tokens: [] }
  const tokens = site.settings.framework.colors.tokens

  const existingSlugs = new Set(tokens.map((t) => normalizeFrameworkColorSlug(t.slug)))
  let maxOrder = tokens.reduce((m, t) => Math.max(m, t.order ?? 0), -1)
  const committed: { slug: string; value: string }[] = []

  for (const { slug: rawSlug, value, dark } of colors) {
    const slug = normalizeFrameworkColorSlug(rawSlug)
    if (existingSlugs.has(slug)) continue
    existingSlugs.add(slug)
    const now = Date.now()
    // A dark value identical to light isn't a real dark override — nothing
    // to import, and marking it enabled would just be noise the user has to
    // clean up by hand (see `ImportColorToken.dark`'s doc).
    const hasDark = dark !== undefined && dark !== value
    const token: FrameworkColorToken = {
      id: nanoid(),
      category: '',
      slug,
      lightValue: value,
      darkValue: hasDark ? dark : '',
      darkModeEnabled: hasDark,
      generateUtilities: { text: false, background: false, border: false, fill: false },
      generateTransparent: false,
      generateShades: { enabled: false, count: 0 },
      generateTints: { enabled: false, count: 0 },
      order: (maxOrder += 1),
      createdAt: now,
      updatedAt: now,
      // `origin` is left unset (undefined), not stamped 'project-css' or
      // similar: this value came from a DIFFERENT site's import, never
      // loaded into THIS project's own document. `filterReemittableColorTokens`
      // (`@core/framework`'s colors.ts) treats undefined the same as
      // 'studio-authored' — still re-emit — which is exactly right here:
      // there is no other declaration of this name anywhere in the current
      // project for the canvas to fall back on.
    }
    tokens.push(token)
    committed.push({ slug, value })
  }

  return committed
}

/**
 * Overwrite existing framework colour tokens in place. The existing token id,
 * slug, and generation flags are retained; only `lightValue` is replaced.
 */
export function overwriteImportedColorTokens(
  site: Draft<SiteDocument>,
  items: { existingTokenId: string; value: string }[],
): { slug: string; value: string }[] {
  if (items.length === 0) return []

  const tokens = site.settings.framework?.colors?.tokens
  if (!tokens || tokens.length === 0) return []

  const committed: { slug: string; value: string }[] = []
  for (const { existingTokenId, value } of items) {
    const existing = tokens.find((t) => t.id === existingTokenId)
    if (!existing) continue
    existing.lightValue = value
    existing.updatedAt = Date.now()
    // The overwrite is itself an import from a DIFFERENT site — if
    // `existing` was previously an extracted token (`origin: 'project-css'`
    // etc., stamped by `tokenExtractBuild.ts`), that origin is now stale:
    // the value just written no longer matches what the currently open
    // project's own CSS declares, so it must be re-emitted like any other
    // studio-authored value or the canvas would silently keep showing the
    // OLD, still-accurate-to-disk value instead of this overwrite.
    existing.origin = undefined
    committed.push({ slug: existing.slug, value })
  }

  return committed
}
