/**
 * parseSourceTag — reads the `data-src-file` / `data-src-loc` attributes
 * injected by `babelPluginSourceTags` back off a rendered element.
 *
 * Coordinate convention (must match `babelPluginSourceTags.ts`): `line` and
 * `col` are both 1-based, with `col` pointing at the first character of the
 * JSX element's tag name.
 */

export interface SourceTagLocation {
  file: string
  line: number
  col: number
}

export interface SourceTaggedElement {
  getAttribute(name: string): string | null
}

const FILE_ATTR = 'data-src-file'
const LOC_ATTR = 'data-src-loc'

export function parseSourceTag(el: SourceTaggedElement): SourceTagLocation | null {
  const file = el.getAttribute(FILE_ATTR)
  const loc = el.getAttribute(LOC_ATTR)
  if (!file || !loc) return null

  const match = /^(\d+):(\d+)$/.exec(loc)
  if (!match) return null

  const line = Number(match[1])
  const col = Number(match[2])
  if (!Number.isFinite(line) || !Number.isFinite(col)) return null

  return { file, line, col }
}
