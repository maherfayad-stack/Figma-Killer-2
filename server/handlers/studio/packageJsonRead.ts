/**
 * packageJsonRead — the `package.json` read + dependency-check primitives,
 * and the "does this config file exist" check, shared between `projectProbe.ts`'s
 * own detectors (framework shape, app-root scoring) and `styleToolchainDetect.ts`
 * (Tailwind/Sass/CSS-in-JS/CSS-Modules).
 *
 * Split out to a dependency-free leaf (same reasoning as `cappedFileRead.ts`'s
 * own doc comment) so extracting the style-toolchain detector OUT of
 * `projectProbe.ts` — to keep that module under the architecture size ceiling
 * (`module-size-budgets.test.ts`) — does not need to import back from the
 * file it was extracted out of. Both `projectProbe.ts` and
 * `styleToolchainDetect.ts` import this leaf; neither imports the other for
 * these three things.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { readJsonFileSafe } from './cappedFileRead'

export const PackageJsonSchema = Type.Object({
  dependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
  devDependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
})
export type PackageJsonShape = Static<typeof PackageJsonSchema>

export function readPackageJson(root: string): PackageJsonShape | undefined {
  return readJsonFileSafe(join(root, 'package.json'), PackageJsonSchema, 2_000_000)
}

export function hasDependency(pkg: PackageJsonShape, name: string): boolean {
  return Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name])
}

/** First name in `names` that exists as a file directly under `root`. */
export function findConfigFile(root: string, names: readonly string[]): string | undefined {
  return names.find((name) => existsSync(join(root, name)))
}
