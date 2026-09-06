/**
 * railAccent — identity tinting for panel rail buttons.
 *
 * Two tiers, and the order matters:
 *
 * 1. **Known surfaces get a deliberate accent** — `railGroupAccent(group)`.
 *    Colour in this design system is identity, never decoration
 *    (`docs/design.md` → "Two-layer colour model"), so a rail's colours have to
 *    *say* something. Two buttons that do the same kind of job share a tint; a
 *    different job gets a different tint. Callers that know what their items
 *    are for pass this through `assignRailAccents`' `explicitAccentForItem`.
 *
 * 2. **Unknown surfaces get a deterministic hash** — plugin panels and the
 *    ad-hoc category lists in the import/export dialogs, where nothing here can
 *    know what a category means. `hashIdentity` uses the full identity string
 *    rather than the first letter (Site, Selectors, and Spacing must not
 *    collapse to one colour), and the assignment helper keeps a visible group
 *    diverse by avoiding repeats until the palette is exhausted.
 */

export const RAIL_ACCENTS = [
  'mint',
  'sky',
  'lilac',
  'peach',
  'rose',
  'lime',
  'gold',
  'cyan',
  'violet',
  'coral',
] as const

export type RailAccent = typeof RAIL_ACCENTS[number]

const DEFAULT_RAIL_ACCENT: RailAccent = 'mint'
const RAIL_ACCENT_TOKEN: Record<RailAccent, string> = {
  mint: 'var(--accent-1)',
  sky: 'var(--accent-3)',
  lilac: 'var(--accent-2)',
  peach: 'var(--accent-4)',
  rose: 'var(--accent-5)',
  lime: 'var(--accent-6)',
  gold: 'var(--accent-7)',
  cyan: 'var(--accent-8)',
  violet: 'var(--accent-9)',
  coral: 'var(--accent-10)',
}

/**
 * What a rail item is FOR. The five jobs the editor's rails actually do:
 *
 *   - `navigate` — move around the document (Explorer).
 *   - `style`    — change how things look (Framework, Classes, and the
 *                  Colors / Typography / Spacing surfaces inside Framework).
 *   - `inspect`  — read what is already there (Inspect, Properties,
 *                  Dependencies).
 *   - `content`  — the words on the page and the conversation about them
 *                  (Content, Comments).
 *   - `assist`   — hand the work to something else (AI assistant).
 */
export type RailAccentGroup = 'navigate' | 'style' | 'inspect' | 'content' | 'assist'

/**
 * Two of these are unchanged from what shipped: Explorer was already pinned to
 * `gold` and Comments to `lilac`. The other three replace a hash draw, so the
 * whole rail now reads as four jobs instead of five unrelated colours.
 */
const RAIL_GROUP_ACCENT: Record<RailAccentGroup, RailAccent> = {
  navigate: 'gold',
  style: 'mint',
  inspect: 'sky',
  content: 'lilac',
  assist: 'violet',
}

/** The accent every rail item doing `group`'s job wears. */
export function railGroupAccent(group: RailAccentGroup): RailAccent {
  return RAIL_GROUP_ACCENT[group]
}

function hashIdentity(value: string): number {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return 0

  let hash = 2166136261
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function railAccent(identity: string): RailAccent {
  const index = hashIdentity(identity) % RAIL_ACCENTS.length
  return RAIL_ACCENTS[index] ?? DEFAULT_RAIL_ACCENT
}

export function railTintVar(accent: RailAccent): string {
  return RAIL_ACCENT_TOKEN[accent]
}

/**
 * Assign an accent per item, in order.
 *
 * `explicitAccentForItem` wins and is returned verbatim — including when two
 * items ask for the same accent. That is the point: items in the same
 * `RailAccentGroup` are *supposed* to match. Repeat-avoidance applies only to
 * the hashed fallback, where a repeat would be meaningless rather than
 * meaningful.
 */
export function assignRailAccents<TItem>(
  items: readonly TItem[],
  identityForItem: (item: TItem) => string,
  explicitAccentForItem?: (item: TItem) => RailAccent | null | undefined,
): RailAccent[] {
  const used = new Set<RailAccent>()

  return items.map((item) => {
    const explicitAccent = explicitAccentForItem?.(item)
    if (explicitAccent) {
      used.add(explicitAccent)
      return explicitAccent
    }

    const startIndex = hashIdentity(identityForItem(item)) % RAIL_ACCENTS.length
    for (let offset = 0; offset < RAIL_ACCENTS.length; offset += 1) {
      const candidate = RAIL_ACCENTS[(startIndex + offset) % RAIL_ACCENTS.length]
      if (candidate && !used.has(candidate)) {
        used.add(candidate)
        return candidate
      }
    }

    return RAIL_ACCENTS[startIndex] ?? DEFAULT_RAIL_ACCENT
  })
}
