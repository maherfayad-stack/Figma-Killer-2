/**
 * designSystemMigrateRequests — the client half of `GET/POST
 * /admin/api/studio/design-system/migrate`: whether the loaded project still
 * imports the retired `@alm-design/design-system` npm, and the one call that
 * moves it onto the Studio-written `<project>/design-system/` folder.
 *
 * A leaf wire module in the same shape as `./styleCompileConsent.ts` — the
 * schemas, the two calls, and the pure show/hide rule. The rule lives HERE
 * rather than inside the banner so it can be tested without a renderer, and so
 * there is exactly one answer to "should this be on screen" for anything that
 * later wants to ask.
 *
 * The POST rewrites the user's source. That is why there is no automatic
 * caller anywhere: it runs from a click, exactly like trust promotion.
 */
import { apiRequest } from '@core/http'
import { Type, type Static } from '@core/utils/typeboxHelpers'

const ROUTE = '/admin/api/studio/design-system/migrate'

export const DesignSystemMigrateStatusSchema = Type.Object({
  /** The project's `package.json` names the retired package. */
  declaresDependency: Type.Boolean(),
  /** A copy of it is still sitting in the project's own `node_modules`. */
  hasInstalledCopy: Type.Boolean(),
  /** Either of the above — the one question the banner asks. */
  importsRetiredPackage: Type.Boolean(),
  /** The project already carries a `design-system/` folder. A half-migrated project has this AND the flag above. */
  designSystemBacked: Type.Boolean(),
})
export type DesignSystemMigrateStatus = Static<typeof DesignSystemMigrateStatusSchema>

export const DesignSystemMigrateResultSchema = Type.Object({
  /** Source files whose imports changed. */
  filesRewritten: Type.Number(),
  /** Import declarations rewritten or removed across those files. */
  importsRewritten: Type.Number(),
  /** The dependency was named in `package.json` and is not any more. */
  removedDependency: Type.Boolean(),
})
export type DesignSystemMigrateResult = Static<typeof DesignSystemMigrateResultSchema>

export async function fetchDesignSystemMigrateStatus(dir: string): Promise<DesignSystemMigrateStatus> {
  return apiRequest(ROUTE, { schema: DesignSystemMigrateStatusSchema, query: { dir } })
}

/** Rewrites the project's imports onto its own `design-system/` folder. A user action, never a load-time one. */
export async function migrateProjectDesignSystem(dir: string): Promise<DesignSystemMigrateResult> {
  return apiRequest(ROUTE, {
    method: 'POST',
    body: { dir },
    schema: DesignSystemMigrateResultSchema,
  })
}

/**
 * The whole show/hide rule: offer the move only while something still points
 * at the package that no longer exists.
 *
 * `designSystemBacked` is deliberately NOT part of it. A project that already
 * has the folder but whose `package.json` still declares the npm is
 * half-migrated — which is the state a failed or interrupted run leaves, and
 * exactly the one that most needs the button offered again.
 */
export function shouldOfferDesignSystemMigrate(status: DesignSystemMigrateStatus): boolean {
  return status.importsRetiredPackage
}

/** "3 files" / "1 file" — the one sentence the success toast needs. */
export function migratedFilesLabel(result: DesignSystemMigrateResult): string {
  const files = result.filesRewritten
  return `${files} ${files === 1 ? 'file' : 'files'}`
}
