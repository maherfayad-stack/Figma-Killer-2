/**
 * applyDesignImportTokens — writes the user-selected preview candidates into
 * the Framework settings via the SAME store actions the Colors/Typography/
 * Spacing panels use for a manual edit. Nothing here talks to the server
 * directly: the resulting `hasUnsavedChanges` flip rides the normal
 * autosave → `fsCodemodAdapter.saveSite` → `.studio/framework.json` path
 * (see that adapter's doc comment) — this module only needs to call the
 * store, exactly like a user clicking around the panels would.
 *
 * Colors are create-or-update by normalized slug (mirrors
 * `tokenRunners.ts`'s `runSetColorTokens` — the same dedup rule the AI tool
 * write path already established, so re-running an import twice patches
 * existing tokens instead of piling up `brand-500-2`).
 *
 * Typography/spacing candidates are numeric font-size / spacing custom
 * properties, not a font-family choice (see `parseCssTokens.ts`'s doc
 * comment) — they land as ONE new `fluid_manual` scale group per import,
 * one `manualSizes` entry per selected candidate. A literal imported value
 * isn't fluid, so `min === max` (a degenerate fluid range with equal
 * endpoints) — the same shape the panel's own `ManualEditor` writes when a
 * user types one fixed px number into both fields.
 */
import type { EditorStore } from '@site/store/types'
import { normalizeFrameworkColorSlug } from '@core/framework'
import type { ColorCandidate, SizeCandidate } from './designImportApi'

export interface ApplyDesignImportSelection {
  colors: ColorCandidate[]
  typography: SizeCandidate[]
  spacing: SizeCandidate[]
}

export interface ApplyDesignImportResult {
  colorsApplied: number
  typographyApplied: number
  spacingApplied: number
}

type Store = Pick<
  EditorStore,
  | 'site'
  | 'createFrameworkColorToken'
  | 'updateFrameworkColorToken'
  | 'createFrameworkTypographyGroup'
  | 'updateFrameworkTypographyGroup'
  | 'createFrameworkSpacingGroup'
  | 'updateFrameworkSpacingGroup'
>

function applyColors(store: Store, colors: readonly ColorCandidate[]): number {
  for (const c of colors) {
    const norm = normalizeFrameworkColorSlug(c.name)
    const existing = store.site?.settings.framework?.colors.tokens ?? []
    const match = existing.find((e) => normalizeFrameworkColorSlug(e.slug) === norm)
    // `c.dark` is only ever present when the source declared a genuinely
    // different dark value (see `ColorTokenCandidate.dark`'s doc) — so its
    // mere presence is the correct `darkModeEnabled` signal. When absent,
    // the dark fields are left out of the patch entirely rather than reset,
    // so re-applying an import never clobbers dark settings a user already
    // configured by hand for an existing token.
    const darkPatch = c.dark !== undefined ? { darkValue: c.dark, darkModeEnabled: true } : {}
    if (match) {
      store.updateFrameworkColorToken(match.id, { lightValue: c.value, ...darkPatch })
    } else {
      store.createFrameworkColorToken({ slug: c.name, lightValue: c.value, ...darkPatch })
    }
  }
  return colors.length
}

/** Builds one `manualSizes` entry per selected size candidate — a fixed (non-fluid) literal, `min === max`. */
function manualSizesFor(candidates: readonly SizeCandidate[]): Array<{ id: string; name: string; min: number; max: number }> {
  return candidates.map((c) => ({ id: crypto.randomUUID(), name: c.name, min: c.px, max: c.px }))
}

export function applyDesignImportTokens(
  store: Store,
  sourceLabel: string,
  selection: ApplyDesignImportSelection,
): ApplyDesignImportResult {
  const colorsApplied = applyColors(store, selection.colors)

  let typographyApplied = 0
  if (selection.typography.length > 0) {
    const group = store.createFrameworkTypographyGroup()
    store.updateFrameworkTypographyGroup(group.id, {
      name: `Imported (${sourceLabel})`,
      mode: 'fluid_manual',
      manualSizes: manualSizesFor(selection.typography),
    })
    typographyApplied = selection.typography.length
  }

  let spacingApplied = 0
  if (selection.spacing.length > 0) {
    const group = store.createFrameworkSpacingGroup()
    store.updateFrameworkSpacingGroup(group.id, {
      name: `Imported (${sourceLabel})`,
      mode: 'fluid_manual',
      manualSizes: manualSizesFor(selection.spacing),
    })
    spacingApplied = selection.spacing.length
  }

  return { colorsApplied, typographyApplied, spacingApplied }
}
