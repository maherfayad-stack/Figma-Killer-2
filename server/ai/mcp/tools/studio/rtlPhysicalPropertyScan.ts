/**
 * rtlPhysicalPropertyScan — WS-10 §2.3's `RTL_PHYSICAL_PROPERTY` finding: scan
 * a node's style declarations for physical-direction CSS (as opposed to
 * logical/flow-relative) — `margin-left` instead of `margin-inline-start`,
 * `text-align: left` instead of `text-align: start`, and so on.
 *
 * Pure and self-contained so it's testable without loading a whole project —
 * `fidelityReport.ts` is the only caller, split out to keep that file's own
 * size down (same reasoning `tokenExtractTailwind.ts` gives for its own
 * split off `tokenExtract.ts`).
 *
 * `StyleRule.styles`/`contextStyles` keys are camelCase (the bag shape
 * `bagToCSS` converts to kebab only at emission — see `classCss.ts`), so the
 * property set here is camelCase too.
 */
import type { StyleRule } from '@core/page-tree'

/** Declarations whose PROPERTY NAME is inherently physical, regardless of value. */
const PHYSICAL_PROPERTIES = new Set([
  'marginLeft',
  'marginRight',
  'paddingLeft',
  'paddingRight',
  'left',
  'right',
  'borderLeft',
  'borderLeftWidth',
  'borderLeftColor',
  'borderLeftStyle',
  'borderRight',
  'borderRightWidth',
  'borderRightColor',
  'borderRightStyle',
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomLeftRadius',
  'borderBottomRightRadius',
])

/** Declarations whose property is directionally neutral, but whose VALUE names a physical side. */
const PHYSICAL_VALUE_PROPERTIES: Record<string, ReadonlySet<string>> = {
  textAlign: new Set(['left', 'right']),
  float: new Set(['left', 'right']),
  clear: new Set(['left', 'right']),
}

/** kebab-case, for a readable finding message — `marginLeft` -> `margin-left`. */
function toKebab(camel: string): string {
  return camel.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

/** Scans one declarations bag, returning readable `property` or `property: value` strings for every physical declaration found. */
function scanDeclarations(styles: Record<string, unknown>): string[] {
  const found: string[] = []
  for (const [prop, value] of Object.entries(styles)) {
    if (PHYSICAL_PROPERTIES.has(prop)) {
      found.push(toKebab(prop))
      continue
    }
    const physicalValues = PHYSICAL_VALUE_PROPERTIES[prop]
    if (physicalValues && typeof value === 'string' && physicalValues.has(value)) {
      found.push(`${toKebab(prop)}: ${value}`)
    }
  }
  return found
}

/**
 * Every physical-direction declaration reachable from `node`'s class
 * assignments, deduplicated, in first-seen order. Scans each assigned rule's
 * BASE styles and every `contextStyles` override (a breakpoint/condition
 * override with a physical property is just as wrong in RTL as the base
 * declaration). Returns `[]` when nothing is found — callers check the
 * length, not truthiness, so an empty match list and "not scanned" both read
 * the same way (there is no "not scanned" case here: every classId is looked
 * up, a missing rule id simply contributes nothing).
 */
export function findPhysicalPropertiesOnNode(
  classIds: readonly string[],
  styleRules: Record<string, StyleRule>,
): string[] {
  const found = new Set<string>()
  for (const classId of classIds) {
    const rule = styleRules[classId]
    if (!rule) continue
    for (const prop of scanDeclarations(rule.styles)) found.add(prop)
    for (const contextStyles of Object.values(rule.contextStyles ?? {})) {
      for (const prop of scanDeclarations(contextStyles)) found.add(prop)
    }
  }
  return [...found]
}
