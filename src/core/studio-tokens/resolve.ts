/**
 * resolve - follow a `var(--x)` chain to the value it ends in.
 *
 * Bounded and cycle-safe, shared by the server's token scans (root-scope map,
 * token catalog, design import) and the editor's Framework scales: one
 * implementation, so a swatch in the picker and the value the agent is told
 * can never come from two different chain-following rules.
 */

const VAR_REF_RE = /^var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,\s*([\s\S]+))?\)$/
const MAX_VAR_RESOLUTION_DEPTH = 8

/** Resolves `raw` through `map`'s `var(--x)` references to a leaf value. An unresolvable reference falls back to its `var(--x, fallback)` fallback text when present, else the unresolved `var(...)` text itself - never throws, never loops (depth + a per-call `seen` set catch both a too-long chain and a genuine cycle). */
export function resolveVarValue(raw: string, map: ReadonlyMap<string, string>, seen: Set<string> = new Set()): string {
  const trimmed = raw.trim()
  const m = VAR_REF_RE.exec(trimmed)
  if (!m) return trimmed
  const refName = m[1]!
  if (seen.has(refName) || seen.size >= MAX_VAR_RESOLUTION_DEPTH) return trimmed
  const refRaw = map.get(refName)
  if (refRaw === undefined) return (m[2] ?? trimmed).trim()
  seen.add(refName)
  return resolveVarValue(refRaw, map, seen)
}
