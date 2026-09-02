/**
 * PackageComponentPlaceholder — `NodeRenderer.tsx`'s fallback for a `pkg.*`
 * node (WS-3.3) that isn't registered yet, replacing the generic "Unknown
 * module" box with something ACTIONABLE, per the work order: "render a
 * clear, actionable placeholder with a one-click promote in the frame where
 * the component would have rendered, not a silent blank" (`meta-03`
 * decision 1).
 *
 * Three states, driven by the SAME two external stores
 * `registerProjectModules.ts`/`fsCodemodAdapter.ts` already maintain (no new
 * Zustand slice — this is ephemeral, per-load client state, same posture as
 * `componentSources`/`vendorCss`):
 *   1. Trust tier `static` (Tier 0, the default) — "Promote this project" button.
 *   2. Trust tier ≥ 1, no refusal recorded yet — "loading" (a fetch is either
 *      in flight or about to start; `useRegisterProjectModules`'s effect
 *      re-runs on every `[projectDir, trust]` transition).
 *   3. Trust tier ≥ 1, the last bundle response was a refusal (e.g. a React
 *      version mismatch, no components found) — shows the server's own
 *      message, no promote action (promoting again wouldn't change the
 *      outcome).
 *
 * Rendered INSIDE the per-frame iframe (portalled by `NodeRenderer`, same as
 * every other module) — see `EditorChromeInjector.tsx`'s
 * `[data-studio-package-placeholder]` rule for why this uses stable
 * `data-*` selectors instead of `NodeRenderer.module.css` classes, and
 * `button-primitive-usage.test.ts`'s §8.16 for why its action is a bare
 * `<button>` instead of the `Button` primitive.
 */
import { useState, useSyncExternalStore } from 'react'
import { useAdminUi } from '@admin/state/adminUi'
import { pushToast } from '@ui/components/Toast'
import { getErrorMessage } from '@core/utils/errorMessage'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import {
  getPackageBundleStatus,
  getStudioTrustTier,
  promoteProjectToTier1,
  subscribePackageBundleStatus,
  subscribeStudioTrustTier,
} from '@site/studio/studioProjectTrust'

interface PackageComponentPlaceholderProps {
  moduleId: string
}

/** `pkg.<sanitized-package>.<ComponentName>` -> `<ComponentName>` — the last dot-separated segment. */
function componentNameFromModuleId(moduleId: string): string {
  const idx = moduleId.lastIndexOf('.')
  return idx === -1 ? moduleId : moduleId.slice(idx + 1)
}

export function PackageComponentPlaceholder({ moduleId }: PackageComponentPlaceholderProps) {
  const trust = useSyncExternalStore(subscribeStudioTrustTier, getStudioTrustTier, getStudioTrustTier)
  const status = useSyncExternalStore(subscribePackageBundleStatus, getPackageBundleStatus, getPackageBundleStatus)
  const projectDir = useAdminUi((s) => s.studioProject?.dir ?? null)
  const [promoting, setPromoting] = useState(false)
  const name = componentNameFromModuleId(moduleId)

  const handlePromote = async () => {
    if (!projectDir || promoting) return
    setPromoting(true)
    try {
      await promoteProjectToTier1(projectDir)
    } catch (err) {
      pushToast({
        kind: 'error',
        title: 'Could not promote project',
        body: getErrorMessage(err, 'Unknown error promoting this project'),
      })
    } finally {
      setPromoting(false)
    }
  }

  if (trust === 'static') {
    return (
      <div data-studio-package-placeholder="" title={`${name} — this project needs to be promoted to render npm package components`}>
        <WarningDiamondSolidIcon size={14} />
        <span data-studio-package-placeholder-label="">{name} needs this project promoted to render</span>
        <button
          type="button"
          data-studio-package-placeholder-promote=""
          disabled={promoting || !projectDir}
          onClick={handlePromote}
        >
          {promoting ? 'Promoting…' : 'Promote project'}
        </button>
      </div>
    )
  }

  if (status && !status.ok) {
    return (
      <div data-studio-package-placeholder="" title={status.message}>
        <WarningDiamondSolidIcon size={14} />
        <span data-studio-package-placeholder-label="">{name} couldn&apos;t render: {status.message}</span>
      </div>
    )
  }

  return (
    <div data-studio-package-placeholder="">
      <WarningDiamondSolidIcon size={14} />
      <span data-studio-package-placeholder-label="">Loading {name}…</span>
    </div>
  )
}
