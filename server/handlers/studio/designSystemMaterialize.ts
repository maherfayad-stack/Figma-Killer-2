/**
 * designSystemMaterialize - the first design-system insert into a project that
 * does not carry the design system yet.
 *
 * Assets offers Studio's built-in design system in every project. An insert
 * writes `import { TabBar } from '../design-system'`, a path RELATIVE to the
 * page, into the user's source - and in a project without the `design-system/`
 * folder that import resolves to nothing: the real app stops building and the
 * canvas shows a placeholder forever. So the insert itself makes the project
 * design-system-backed, in the same batch: `.studio/meta.json`
 * `designSystem: 'alm'` and the folder `ensureDesignSystemFiles` writes from it.
 *
 * ## One undo
 *
 * The batch's undo-journal entry carries `designSystemCreated`
 * (`undoJournal.ts`); restoring it puts the page back and then calls
 * {@link dematerializeDesignSystem}, which removes exactly the files Studio
 * wrote and the meta field - unless another file still imports the folder, in
 * which case the folder stays (taking it would break that file) and only the
 * insert is undone.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { listWorkspaceFiles } from '@core/page-parser'
import { PROJECT_DESIGN_SYSTEM_DIR, isDesignSystemBacked } from './builtinDesignSystem'
import { ensureDesignSystemFiles, removeDesignSystemFiles } from './designSystemFiles'
import { mergeStudioMeta, readStudioMeta, writeStudioMeta } from './studioMeta'

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/

/** Studio's own preview shell imports the folder from `providers.generated.jsx`; it is rewritten from the project's state, so it is not a reason to keep the folder. */
const GENERATED_SHELL_FILE = /^prototype\/[^/]+\.generated\.[cm]?[jt]sx?$/

/** True when `value` names a design-system import anywhere inside it (an insert's subtree, a wrap's wrapper, a slot fill). */
export function namesDesignSystemImport(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(namesDesignSystemImport)
  if (value === null || typeof value !== 'object') return false
  for (const [key, child] of Object.entries(value)) {
    if (key === 'designSystemImport' && child === true) return true
    if (namesDesignSystemImport(child)) return true
  }
  return false
}

/**
 * Makes `dir` design-system-backed when it is not, and says whether THIS call
 * did. A project that already carries the folder (hand-made or Studio-made) is
 * left exactly as it is.
 */
export function materializeDesignSystem(dir: string): boolean {
  if (isDesignSystemBacked(dir)) return false
  mergeStudioMeta(dir, { designSystem: 'alm' })
  ensureDesignSystemFiles(dir)
  if (isDesignSystemBacked(dir)) return true
  // The vendored source is missing: leave nothing half-declared.
  dematerializeDesignSystem(dir)
  return false
}

/** True when a source file outside the folder still imports `design-system` by a relative specifier. */
function designSystemStillImported(dir: string): boolean {
  const importsFolder = /from\s+['"](?:\.{1,2}\/)+design-system(?:\/[^'"]*)?['"]/
  for (const rel of listWorkspaceFiles(dir)) {
    if (!SOURCE_EXTENSION.test(rel) || GENERATED_SHELL_FILE.test(rel) || rel.startsWith(`${PROJECT_DESIGN_SYSTEM_DIR}/`)) continue
    const file = join(dir, ...rel.split('/'))
    if (!existsSync(file)) continue
    if (importsFolder.test(readFileSync(file, 'utf8'))) return true
  }
  return false
}

/** Undo of {@link materializeDesignSystem}. Returns whether the folder and the meta field were removed. */
export function dematerializeDesignSystem(dir: string): boolean {
  if (designSystemStillImported(dir)) return false
  removeDesignSystemFiles(dir)
  const { designSystem: _removed, ...rest } = readStudioMeta(dir)
  writeStudioMeta(dir, rest)
  return true
}
