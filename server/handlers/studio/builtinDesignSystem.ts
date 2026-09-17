/**
 * builtinDesignSystem — where Studio's own copy of the ALM design system lives
 * (`vendor/alm-design-system/`, DS-1) and how a project declares it uses it
 * (a Studio-written `<project>/design-system/` folder, DS-2).
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Studio's vendored design-system package root (source + committed dist). */
export const BUILTIN_DESIGN_SYSTEM_DIR = resolve(process.cwd(), 'vendor', 'alm-design-system')

/** The folder name, relative to a project root, that carries the project's copy. */
export const PROJECT_DESIGN_SYSTEM_DIR = 'design-system'

/** True when the project carries a design-system folder with an entry file. */
export function isDesignSystemBacked(projectDir: string): boolean {
  return existsSync(join(projectDir, PROJECT_DESIGN_SYSTEM_DIR, 'index.js'))
}
