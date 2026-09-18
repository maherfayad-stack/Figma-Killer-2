/**
 * The two ordered lists of Studio sub-routers `tryServeStudio` walks.
 *
 * Route handling lives with the feature rather than in one switch, for the
 * same reason `server/router.ts` composes an array of `tryServe*` handlers: a
 * single shared route table is the file every concurrent change has to touch,
 * and it grows without bound. Each entry returns `null` for a path it does not
 * own, so ordering here is not load-bearing.
 *
 * The lists live in their own module rather than in `studio.ts` because the
 * imports alone are ~40 lines of churn that every new feature edits — keeping
 * them here is what keeps `studio.ts` about ROUTES rather than about wiring,
 * and gives a new sub-router exactly one line to add in exactly one place.
 *
 * **Adding a sub-router is two edits, not one.** The list below, and a
 * declaration per path in `routeCapabilities.ts` — without the second, the
 * gate answers 404 and the new routes are unreachable (deliberately; see that
 * module's doc).
 */
import { tryServeStudioProbe } from './projectProbe'
import { tryServeStudioInstall } from './installDeps'
import { tryServeStudioIngest } from './importUpload'
import { tryServeStudioAssetUpload } from './assetUpload'
import { tryServeStudioReferenceUpload } from './referenceUpload'
import { tryServeStudioComponentBundle } from './componentBundle'
import { tryServeStudioTokens } from './tokenExtract'
import { tryServeStudioTrustTier } from './trustTier'
import { tryServeStudioLiveOriginInfo } from './liveOriginInfo'
import { tryServeStudioStyleCompileConsent } from './styleCompileConsent'
import { tryServeStudioDesignSystemMigrate } from './designSystemMigrate'
import { tryServeStudioExtractComponent } from './extractComponent'
import { tryServeStudioPreviewAxes } from './previewAxes'
import { tryServeStudioLocalizedPage } from './localizedPage'
import { tryServeStudioComponents } from './components'
import { tryServeStudioIcons } from './iconCatalog'
import { tryServeStudioProjectAssets } from './projectAssets'
import { tryServeStudioTranslations } from './translations'
import { tryServeStudioI18nSetup } from './i18nSetup'
import { tryServeStudioProjectRoutes } from './projectRoutes'
import { tryServeStudioTrashRoutes } from './trashRoutes'
import { tryServeStudioGithubImport } from './githubImportRoutes'
import { tryServeStudioReloadScope } from './reloadScope'
import { tryServeStudioComments } from './commentsRoutes'
import { tryServeStudioNodeExport } from './nodeExportRoutes'
import { tryServeStudioShares } from './shareRoutes'
import { tryServeStudioPrototype } from './prototypeRoutes'
import { tryServeStudioGit } from './git'
import { tryServeStudioGitSync } from './gitSyncRoutes'
import { tryServeStudioGithubAuth } from './githubAuthRoutes'
import { tryServeStudioGitRemote } from './gitRemoteRoutes'
import { tryServeStudioDeploy } from './deploy'
import { tryServeStudioDevServer } from './devServer'
import { tryServeStudioStories } from './storiesRoutes'

/**
 * Sub-routers with the uniform `(req, url, pathname)` signature — everything
 * that needs nothing but a project directory.
 */
export const STUDIO_SUB_ROUTERS = [
  tryServeStudioProbe,
  tryServeStudioGithubImport,
  tryServeStudioInstall,
  tryServeStudioIngest,
  tryServeStudioAssetUpload,
  tryServeStudioReferenceUpload,
  tryServeStudioComponentBundle,
  tryServeStudioTrustTier,
  tryServeStudioLiveOriginInfo,
  tryServeStudioStyleCompileConsent,
  tryServeStudioDesignSystemMigrate,
  tryServeStudioTokens,
  tryServeStudioExtractComponent,
  tryServeStudioPreviewAxes,
  tryServeStudioLocalizedPage,
  tryServeStudioComponents,
  tryServeStudioIcons,
  tryServeStudioProjectAssets,
  tryServeStudioTranslations,
  tryServeStudioI18nSetup,
  tryServeStudioReloadScope,
  tryServeStudioPrototype,
  tryServeStudioGit,
  tryServeStudioGitRemote,
  tryServeStudioGitSync,
  tryServeStudioDeploy,
  tryServeStudioDevServer,
  tryServeStudioStories,
  tryServeStudioTrashRoutes,
] as const

/**
 * The same, for sub-routers that additionally need the `DbClient` and the
 * signed-in `AuthUser` because each acts ON BEHALF OF somebody (a byline, a
 * share link's owner, a capture's fallback tab, a GitHub credential) rather
 * than merely reading a project directory.
 *
 * The user arrives already authenticated: `gateStudioRequest` resolved it for
 * the whole surface, so nothing in this list calls an auth helper of its own.
 */
export const STUDIO_SESSION_SUB_ROUTERS = [
  tryServeStudioGithubAuth,
  tryServeStudioComments,
  tryServeStudioProjectRoutes,
  tryServeStudioShares,
  tryServeStudioNodeExport,
] as const
