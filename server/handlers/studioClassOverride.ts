/**
 * studioClassOverride — the server half of G-2b's per-instance CLASS override:
 * `expose-class` (change a class's declarations for one instance) and
 * `promote-class-override` ("Apply to all"). The codemods are
 * `@core/ast-codemods`' `classOverride.ts`; this module decodes the edit's node
 * id into the positions it names (every one through the single path decoder the
 * caller passes in, so containment is per file), contains the stylesheet, hands
 * the codemod the stylesheet's text and the one place that writes it, and turns
 * a refusal into the batch's named refusal.
 *
 * Like every one-shot writer here it writes several files (the page, the
 * component, the stylesheet) and is journaled: ⌘Z is the undo journal's
 * `restore`, byte for byte.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Project } from 'ts-morph'
import { classNamesOfStylesheets, exposeClassOverride, promoteClassOverride } from '@core/ast-codemods'
import { classifyStylesheetEditability } from '@core/css-codemods'
import { listWorkspaceFiles, writeSourceFile } from '@core/page-parser'
import { inlineSegments } from '@core/page-tree'
import type { Static } from '@core/utils/typeboxHelpers'
import { resolveContainedCssPath } from './studioCssWriteback'
import { StudioEditRefusalError } from './studioEditRefusals'
import type { ExposeClassEditSchema, PromoteClassOverrideEditSchema } from './studioClassOverrideSchemas'
import type { StudioEditApplyOutcome } from './studioEditSchemas'

export type ClassOverrideEdit = Static<typeof ExposeClassEditSchema> | Static<typeof PromoteClassOverrideEditSchema>

/** A decoded, contained source position: what the path decoder (`studioEditLocation`) answers. */
export interface LocatedSource {
  rel: string
  line: number
  col: number
}

export type LocateNode = (nodeId: string) => LocatedSource | null

/** The stylesheets scanned for a name a fresh modifier must not take: bounded, so a vendored dump cannot stall a write. */
const MAX_SCANNED_STYLESHEETS = 400
const MAX_STYLESHEET_BYTES = 2 * 1024 * 1024

function decodeSegments(edit: ClassOverrideEdit, locate: LocateNode): { callSites: LocatedSource[]; element: LocatedSource } | null {
  const segments = inlineSegments(edit.nodeId)
  if (segments.length < 2) return null
  const located = segments.map((segment) => locate(segment))
  if (located.some((location) => location === null)) return null
  const all = located as LocatedSource[]
  return { callSites: all.slice(0, -1), element: all[all.length - 1]! }
}

/**
 * Every absolute file the edit writes: the call site of each segment, the
 * component, and the stylesheet. The undo journal captures them BEFORE the first
 * write, and the batch's line-count check reads the same set.
 */
export function classOverrideTouchedFiles(dir: string, edit: ClassOverrideEdit, locate: LocateNode): string[] {
  const files = new Set<string>()
  for (const segment of inlineSegments(edit.nodeId)) {
    const location = locate(segment)
    if (location) files.add(join(dir, location.rel))
  }
  const css = resolveContainedCssPath(dir, edit.file)
  if (css) files.add(css)
  return [...files]
}

function projectClassNames(dir: string): Set<string> {
  const texts: string[] = []
  for (const rel of listWorkspaceFiles(dir)) {
    if (texts.length >= MAX_SCANNED_STYLESHEETS) break
    if (!/\.css$/i.test(rel)) continue
    try {
      const text = readFileSync(join(dir, rel), 'utf8')
      if (text.length <= MAX_STYLESHEET_BYTES) texts.push(text)
    } catch (_err) {
      // A stylesheet that cannot be read names no class; the write that follows does not depend on it.
    }
  }
  return classNamesOfStylesheets(texts)
}

export function applyClassOverrideEdit(dir: string, edit: ClassOverrideEdit, locate: LocateNode, project: Project | undefined): StudioEditApplyOutcome {
  const decoded = decodeSegments(edit, locate)
  if (!decoded) return { applied: false, unwritable: 'no-source-location' }
  const editability = classifyStylesheetEditability(edit.file)
  if (editability.kind === 'compiled') throw new StudioEditRefusalError('compiled-stylesheet', editability.reason)
  const cssPath = resolveContainedCssPath(dir, edit.file)
  if (cssPath === null) return { applied: false, unwritable: 'stylesheet-unavailable' }

  const text = readFileSync(cssPath, 'utf8')
  const common = {
    workspaceRoot: dir,
    callSites: decoded.callSites.map((site) => ({ file: join(dir, site.rel), line: site.line, col: site.col })),
    css: { text, write: (next: string) => writeSourceFile(cssPath, next), convention: /\.module\.css$/i.test(edit.file) ? ('module' as const) : ('plain' as const) },
    selector: edit.selector,
    ...(edit.atRule !== undefined ? { atRule: edit.atRule } : {}),
    ...(project ? { project } : {}),
  }
  const result =
    edit.kind === 'expose-class'
      ? exposeClassOverride({
          ...common,
          element: { file: join(dir, decoded.element.rel), line: decoded.element.line, col: decoded.element.col },
          declarations: edit.declarations,
          projectClassNames: () => projectClassNames(dir),
        })
      : promoteClassOverride({ ...common, properties: edit.properties })
  if (!result.ok) throw new StudioEditRefusalError(result.refusal.reason, result.refusal.message)
  return { applied: true }
}
