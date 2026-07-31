/**
 * tokenExtractTailwind — `tokenExtract.ts`'s `tailwind-theme` source: a
 * bounded, non-executing object-literal scanner over `theme.extend`'s
 * `colors`/`spacing`/`fontSize`. Mirrors `projectProbe.ts`'s
 * `extractViteAliases` — "static read only," same posture: genuinely
 * running the config would mean executing arbitrary code from an unaudited
 * repo, which nothing in the probe/extract layer ever does. Split out of
 * `tokenExtract.ts` purely to stay under the module-size-budget ceiling.
 */
import { isCssColorValue } from '@core/siteImport'
import { emptyClassifiedTokens, toPx, type ClassifiedTokens } from './tokenExtractCssScan'

/** Scans `text` from `openIndex` (which must point at a `{`) to its matching `}`, and returns the content between them plus the index just past the close brace. `undefined` when the braces never balance. */
function matchBalancedBraces(text: string, openIndex: number): { content: string; endIndex: number } | undefined {
  let i = openIndex + 1
  let depth = 1
  const start = i
  const n = text.length
  while (i < n && depth > 0) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') depth--
    i++
  }
  if (depth !== 0) return undefined
  return { content: text.slice(start, i - 1), endIndex: i }
}

/** The balanced-brace body of the first `key: {` match in `text`, or `undefined` if the key isn't found or braces never balance. */
function findBracedBlock(text: string, key: string): string | undefined {
  const re = new RegExp(`\\b${key}\\s*:\\s*\\{`)
  const m = re.exec(text)
  if (!m) return undefined
  return matchBalancedBraces(text, m.index + m[0].length - 1)?.content
}

/** Shallow `key: 'value'` pairs, plus ONE level of nesting flattened as `key-subkey` (a shade palette: `primary: { 500: '#0ea5e9' }` -> `primary-500`). Array-valued entries (Tailwind's `fontSize` tuple form, `key: ['1rem', {...}]`) take only the leading string. Anything else (a function call, a spread, a template literal) is silently skipped — a config that builds its theme some other way yields fewer tokens here, never a wrong one. */
function readShallowStringMap(block: string): Map<string, string> {
  const out = new Map<string, string>()
  let i = 0
  const n = block.length
  while (i < n) {
    // Skip whitespace/commas between entries.
    while (i < n && /[\s,]/.test(block[i]!)) i++
    if (i >= n) break
    const keyMatch = /^['"]?([A-Za-z0-9_-]+)['"]?\s*:\s*/.exec(block.slice(i))
    if (!keyMatch) {
      // Can't parse this entry — skip to the next comma at depth 0.
      const next = block.indexOf(',', i)
      if (next === -1) break
      i = next + 1
      continue
    }
    const key = keyMatch[1]!
    i += keyMatch[0].length
    const rest = block.slice(i)
    const strMatch = /^['"]([^'"]*)['"]/.exec(rest)
    const arrMatch = /^\[\s*['"]([^'"]*)['"]/.exec(rest)
    if (strMatch) {
      out.set(key, strMatch[1]!)
      i += strMatch[0].length
    } else if (arrMatch) {
      out.set(key, arrMatch[1]!)
      // Consume to the matching close bracket so the outer loop resyncs correctly.
      const closeIdx = rest.indexOf(']')
      i += closeIdx === -1 ? arrMatch[0].length : closeIdx + 1
    } else if (rest[0] === '{') {
      // One level of nesting — flatten as `key-subkey`.
      const nested = matchBalancedBraces(rest, 0)
      if (nested) {
        for (const [subKey, subVal] of readShallowStringMap(nested.content)) out.set(`${key}-${subKey}`, subVal)
        i += nested.endIndex
      } else {
        break // unbalanced — nothing more can be parsed reliably
      }
    } else {
      // Neither a string, array, nor object leaf (a function call, an
      // identifier reference, …) — skip to the next comma.
      const next = block.indexOf(',', i)
      if (next === -1) break
      i = next + 1
    }
  }
  return out
}

export function extractTailwindThemeTokens(configText: string): ClassifiedTokens {
  const result = emptyClassifiedTokens()
  const themeBlock = findBracedBlock(configText, 'extend') ?? findBracedBlock(configText, 'theme')
  if (!themeBlock) return result

  const colorsBlock = findBracedBlock(themeBlock, 'colors')
  if (colorsBlock) {
    for (const [key, value] of readShallowStringMap(colorsBlock)) {
      if (isCssColorValue(value)) result.colors.push({ name: `--${key}`, light: value })
      else result.unclassifiedCount++
    }
  }

  const spacingBlock = findBracedBlock(themeBlock, 'spacing')
  if (spacingBlock) {
    for (const [key, value] of readShallowStringMap(spacingBlock)) {
      const px = toPx(value)
      if (px !== null) result.spacing.push({ name: `--space-${key}`, px })
      else result.unclassifiedCount++
    }
  }

  const fontSizeBlock = findBracedBlock(themeBlock, 'fontSize')
  if (fontSizeBlock) {
    for (const [key, value] of readShallowStringMap(fontSizeBlock)) {
      const px = toPx(value)
      if (px !== null) result.typographySizes.push({ name: `--text-${key}`, px })
      else result.unclassifiedCount++
    }
  }

  return result
}
