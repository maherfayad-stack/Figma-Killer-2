/**
 * Studio MCP tool — 9.2 `studio_render_reference`, Tier 2 of the visual-audit
 * trio (WS-9.2). Boots the OPEN PROJECT's own dev server and screenshots a
 * route through a real headless browser — the "compare against the live one"
 * half of requirement 10.
 *
 * **Tier 2, not Tier 0/1.** Every other Studio MCP tool reads source
 * statically or writes it back; this one EXECUTES the project's own code —
 * whatever `scripts.dev` runs, including every dependency it imports. That is
 * exactly the blast-radius `studio.run.project` exists to gate
 * (`mcp-tooling.md`'s "Never let a tool publish, deploy, or run project code
 * without an explicit, separately-gated capability").
 *
 * **TWO gates, not one (A10 / `sec-05` finding 1).** The capability alone was
 * never enough, and for a year it was all this tool had: it answers "may this
 * CALLER run project code at all", which is a property of the connector, not
 * of the repository it is pointed at. A connector holding
 * `studio.run.project` could therefore boot ANY project's dev server,
 * including one whose owner never promoted it past Tier 0 — strictly weaker
 * than the HTTP route (`devServer.ts`) doing the same spawn, which has always
 * demanded `trust === 'run-project'`. So this handler now ALSO calls
 * `checkTrustTier(dir, 'run-project')` (`handlers/studio/trustGate.ts`, the
 * same helper the route uses) and refuses a Tier-0/1 project with the shared
 * `trust-tier-required` code.
 *
 * The agent may ask for a promotion and may never perform one — that is
 * enforced, not merely stated: `.studio/` is refused to its native
 * `Write`/`Edit` by the generated `PreToolUse` hook
 * (`handlers/studio/agentWriteScope.ts`), because otherwise the gate below
 * would be a file the caller it gates could edit. What the tier does NOT
 * prove is that a human weighed this particular project: every project
 * starts at `run-project` (`DEFAULT_TRUST_TIER` — owner decision, 2026-09-20),
 * so both of this tool's gates are satisfied by default for every project
 * Studio can run, and no human ever answered a question to get there. **Tier
 * 2 is a PRODUCT DEFAULT, not a consent boundary** (`sec-12`) — anything that
 * genuinely needs a human to have agreed must ask at the point of use, and
 * the single-operator posture is what makes the default acceptable at all.
 * `docs/reference/capabilities.md` states the full boundary.
 *
 * Because both gates exist, the CAPABILITY can now be held by an ordinary
 * operator: `studio.run.project` is granted to the built-in Admin role
 * (`server/auth/capabilities.ts`), which is what makes the only
 * ground-truth verification tool in the toolset reachable at all. What used
 * to be one coarse, never-granted switch is now "this operator may run
 * project code" × "this project has been promoted".
 *
 * **`route`, not `pageId`.** A Studio page (one parsed screen FILE) does not
 * always correspond to an addressable URL in the project's own dev server —
 * confirmed against the real eSIM corpus, whose `App.jsx` exposes exactly 3
 * of its 15 screens via a `?page=` query param; the rest (`ActivationFlowScreen`,
 * `DevicePickerSheet`, `SelectPackageSheet`, …) are reached only by simulating
 * in-app interaction (tapping "Install", picking a device), which this tool
 * does not drive. Guessing a route from a Studio slug would silently produce
 * a wrong reference image for most projects; requiring an explicit `route`
 * keeps the honesty this family is built on — the caller supplies whatever
 * addressing scheme the project's OWN router/URL-state actually uses.
 *
 * **Dev-server discovery, not a forced port.** Frameworks disagree on how to
 * request an ephemeral port (Vite: `--port`; Next: `--port`/`-p`; CRA: `PORT`
 * env) and some ignore a taken port by auto-incrementing (Vite). Forcing a
 * flag that doesn't apply to a given framework would silently do nothing —
 * more true to "any React repo" is to spawn the script UNCHANGED and parse
 * the URL it actually prints (`waitForServerUrl` below), which works
 * regardless of which port the framework picked or why.
 *
 * **Idle-timeout reuse.** A dev server is expensive to boot (module graph +
 * cold Vite/webpack compile), so a project's server is kept running and
 * reused across calls, torn down after `idleTimeoutMs` of no further
 * `studio_render_reference` calls for that project — never left running
 * forever, never re-booted on every single call either.
 *
 * **The process manager itself lives in `../../../../handlers/studio/
 * devServer.ts`** (Track L's `live-01`) — one spawner, shared with the new
 * `/admin/api/studio/dev-server/*` routes and the client prewarm hook, not
 * duplicated here. This module is a CONSUMER: `ensureDevServer` boots or
 * reuses the project's dev server, `scheduleDevServerIdleTeardown` starts
 * this call's own idle clock on success, and everything below that —
 * launching the headless browser, navigating, screenshotting — is this
 * tool's own concern and stays here.
 */
import { Type } from '@core/utils/typeboxHelpers'
import { aiToolOk, toolRefusal } from '@core/ai'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { resolveAppRoot } from '../../../../handlers/studio/appRoot'
import { TRUST_TIER_REQUIRED_CODE, checkTrustTier } from '../../../../handlers/studio/trustGate'
import {
  ensureDevServer,
  scheduleDevServerIdleTeardown,
  type DevServerOverrides,
} from '../../../../handlers/studio/devServer'
import {
  defaultLaunchBrowser,
  type PlaywrightLikeBrowser,
  type PlaywrightLikePage,
} from '../../capture/browserPool'

// The browser plumbing this tool pioneered now lives in `capture/browserPool.ts`,
// where the headless capture driver shares it. Re-exported because this
// module's own `ReferenceRenderOverrides` is typed in terms of them and
// callers (including its test) inject fakes against these names.
export type { PlaywrightLikeBrowser, PlaywrightLikePage }

const NAV_TIMEOUT_MS = 20_000
/** Grace period after `load` for client-side React mount/render to settle — see the `goto` call site. */
const NAV_SETTLE_MS = 500
const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60_000

/** Injectable seams for tests — never touched by real callers. */
export interface ReferenceRenderOverrides extends DevServerOverrides {
  launchBrowser?: () => Promise<PlaywrightLikeBrowser>
  navTimeoutMs?: number
}

const InputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
    ),
    route: Type.String({
      minLength: 1,
      description:
        'The path (+ optional query string) this project\'s OWN dev server serves the screen at, e.g. "/" or "/?page=homepage" — NOT necessarily the Studio page\'s slug. Call studio_project_profile / read the project\'s router or URL-state code first if unsure which routes exist.',
    }),
    width: Type.Optional(Type.Integer({ minimum: 200, maximum: 4000, description: 'Viewport width in px. Default 390.' })),
    height: Type.Optional(Type.Integer({ minimum: 200, maximum: 4000, description: 'Viewport height in px. Default 844.' })),
    dpr: Type.Optional(Type.Number({ minimum: 0.5, maximum: 3, description: 'Device scale factor for the screenshot. Default 1.' })),
    idleTimeoutMs: Type.Optional(
      Type.Integer({ minimum: 5_000, maximum: 30 * 60_000, description: 'How long to keep this project\'s dev server running after the last call before tearing it down. Default 120000 (2 min).' }),
    ),
  },
  { additionalProperties: false },
)

export function createReferenceRenderTool(overrides: ReferenceRenderOverrides = {}): AiTool {
  return {
    name: 'studio_render_reference',
    scope: 'shared',
    execution: 'server',
    mutates: true,
    requiredCapabilities: ['studio.run.project'],
    description:
      'Tier 2: boots the OPEN PROJECT\'s own dev server (its "dev" or "start" script, via the detected package manager) and screenshots `route` through a real headless browser at the given viewport — the ground truth to compare a studio_export_frames capture against. Gated TWICE because this EXECUTES the project\'s own code, unlike every other Studio tool: the caller needs studio.run.project, AND the project itself must be promoted to "run-project" trust. A project at "static" or "render-packages" trust refuses with code "trust-tier-required" — ask the user to promote it in Studio and call again; you may never promote it yourself, and calling again without that promotion returns the same refusal. `route` must be a path this project\'s OWN dev server actually serves (its router or URL-state, not necessarily the Studio page slug) — not every parsed Studio page has one; screens reached only via in-app interaction (a tap, a picked option) are not reachable this way. The dev server is reused across calls for the same project and torn down after `idleTimeoutMs` of inactivity. If the dev server fails to boot, returns ok:false with the captured stdout/stderr tail — never a synthetic result.',
    inputSchema: InputSchema,
    handler: async (input, ctx: ToolContext) => {
      const {
        dir: dirInput,
        route,
        width = 390,
        height = 844,
        dpr,
        idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
      } = input as {
        dir?: string
        route: string
        width?: number
        height?: number
        dpr?: number
        idleTimeoutMs?: number
      }

      const dir = resolveToolProjectDir(dirInput, ctx)
      const appRoot = resolveAppRoot(dir)

      // Gate 2 of 2 — the PROJECT's own tier (A10, `sec-05` finding 1). Gate 1
      // (`requiredCapabilities: ['studio.run.project']`) was already enforced
      // by `toolAllowedForCapabilities` before this handler ran; it says the
      // caller may run project code, not that THIS project may be run.
      // Read off `dir`, never `appRoot`: `.studio/` lives at the project root,
      // and a monorepo's nested app root has no meta file of its own.
      const trust = checkTrustTier(dir, 'run-project')
      if (!trust.ok) {
        return toolRefusal(
          TRUST_TIER_REQUIRED_CODE,
          `This project is at "${trust.trust}" trust, and booting its dev server runs its own code — that needs the highest tier ("run-project").`,
          {
            remedy: 'Ask the user to promote the project in Studio, then call this again; you may not promote it yourself, so this same call will keep refusing until they do.',
            details: { trust: trust.trust, requiredTrust: trust.required, dir },
          },
        )
      }

      const server = await ensureDevServer(dir, overrides)
      if (!server.ok) {
        // `toolRefusal` renders the code into `error` for exactly the reason
        // this branch used to hand-roll: `server.ts`'s CallToolResult builder
        // only forwards `output.error` on an `ok:false` result, dropping every
        // other field, so a code that lives only in a sibling property is a
        // code the model never sees.
        return toolRefusal('dev-server-failed-to-boot', server.error, {
          remedy: 'Read the captured log, fix the cause in the project, then call again — the same call fails identically until the dev script comes up.',
          details: { log: server.log, dir, appRoot },
        })
      }
      scheduleDevServerIdleTeardown(dir, idleTimeoutMs)

      const normalizedRoute = route.startsWith('/') ? route : `/${route}`
      const url = `${server.baseUrl}${normalizedRoute}`

      const launchBrowser = overrides.launchBrowser ?? defaultLaunchBrowser
      let browser: PlaywrightLikeBrowser | null = null
      try {
        browser = await launchBrowser()
        const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr })
        try {
          // `waitUntil: 'networkidle'` never fires against a dev server — Vite
          // (and every comparable dev server) keeps a persistent HMR WebSocket
          // open, so the network is never "idle." `'load'` fires once the
          // document + its initial resources finish loading; a short settle
          // delay afterward covers client-side React mount/render, which
          // completes after the load event, not as part of it.
          await page.goto(url, { waitUntil: 'load', timeout: overrides.navTimeoutMs ?? NAV_TIMEOUT_MS })
          await page.waitForTimeout(NAV_SETTLE_MS)
          const buffer = await page.screenshot({ type: 'png' })
          return aiToolOk(
            { ok: true, dir, appRoot, url, width, height, capturedAt: Date.now() },
            [{ mimeType: 'image/png', data: buffer.toString('base64') }],
          )
        } finally {
          await page.close()
        }
      } catch (err) {
        return toolRefusal('render-failed', `Could not render ${url}: ${err instanceof Error ? err.message : String(err)}`, {
          remedy: 'The dev server is up, so confirm this is a route it actually serves before trying again.',
        })
      } finally {
        if (browser) await browser.close()
      }
    },
  }
}

export const referenceRenderTool: AiTool = createReferenceRenderTool()
export const studioReferenceMcpTools: AiTool[] = [referenceRenderTool]
