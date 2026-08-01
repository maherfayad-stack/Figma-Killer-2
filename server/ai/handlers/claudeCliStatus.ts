/**
 * Claude CLI availability status — GET /admin/api/ai/providers/claude-cli/status
 *
 * WS-11 step 2's "disabled with the reason shown" UI needs to know, before
 * the user tries to add a credential, whether this provider can work at all
 * on this host: unsupported platform (macOS), binary not installed, installed
 * but logged out, or logged in and ready. Runs the same zero-cost
 * `claude auth status --json` probe the driver itself uses
 * (`server/ai/drivers/claudeCliProbe.ts`) — no model call, no session file.
 *
 * Never silently absent (the same rule WS-10's probes follow): every
 * non-`logged-in` case carries a `reason`, and the logged-out case also
 * carries the exact L1 login one-liner to run.
 *
 * Also carries `terminalLogin` (`{ available, reason? }`, from
 * `claudeCliTerminalLaunch.ts`'s `resolveTerminalLaunchSupport`) — whether
 * THIS request can use the one-click "Log in with Claude" terminal-launch
 * path (`POST .../claude-cli/login-terminal`) at all. Independent of the CLI
 * availability classification below: a remote caller or an unsupported
 * platform can still be `logged-out` while `terminalLogin.available` is
 * false, in which case the dialog falls back to the manual/paste-a-token
 * path with `terminalLogin.reason` shown.
 */

import { jsonResponse } from '../../http'
import { requireCapability } from '../../auth/authz'
import { isLoopbackRequest } from '../../auth/security'
import type { DbClient } from '../../db/client'
import {
  buildClaudeCliLoginCommand,
  claudeCliPlatformSupport,
  ensureClaudeCliConfigDir,
  resolveClaudeCliDataRoot,
  type ClaudeCliPlatformSupport,
} from '../../handlers/studio/claudeCliEnv'
import { probeClaudeCliAuth, type ClaudeCliAvailability } from '../drivers/claudeCliProbe'
import { resolveTerminalLaunchSupport, type TerminalLaunchSupport } from '../drivers/claudeCliTerminalLaunch'

export type ClaudeCliStatusAvailability =
  | 'logged-in'
  | 'logged-out'
  | 'not-installed'
  | 'unsupported'
  | 'probe-failed'

/** The full wire shape — what the route actually returns. */
export interface ClaudeCliStatusResponse {
  readonly availability: ClaudeCliStatusAvailability
  readonly reason?: string
  readonly loginCommand?: string
  readonly subscriptionType?: string
  readonly terminalLogin: TerminalLaunchSupport
}

/**
 * `classifyClaudeCliStatus`'s own return shape — everything except
 * `terminalLogin`, which depends on the live request (loopback-ness) rather
 * than the platform/probe inputs this pure function classifies. `handleStatus`
 * merges `terminalLogin` in separately on every return path.
 */
export type ClaudeCliClassification = Omit<ClaudeCliStatusResponse, 'terminalLogin'>

// ---------------------------------------------------------------------------
// Router entry
// ---------------------------------------------------------------------------

export function tryHandleAiClaudeCliStatus(
  req: Request,
  db: DbClient,
  pathname: string,
): Promise<Response> | null {
  if (pathname !== '/admin/api/ai/providers/claude-cli/status') return null
  return handleStatus(req, db)
}

async function handleStatus(req: Request, db: DbClient): Promise<Response> {
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
  }
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse

  // Independent of CLI availability itself — whether the "Log in with
  // Claude" button in the Add-credential dialog has anything to do. Computed
  // once and merged onto every return below, including the early ones.
  const terminalLogin = resolveTerminalLaunchSupport(process.platform, isLoopbackRequest(req))

  const platform = claudeCliPlatformSupport()
  if (!platform.supported) {
    return jsonResponse({ ...classifyClaudeCliStatus(platform, null, null), terminalLogin })
  }

  let configDir: string
  try {
    configDir = ensureClaudeCliConfigDir(resolveClaudeCliDataRoot(), userOrResponse.id)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return jsonResponse({
      ...classifyClaudeCliStatus(platform, { status: 'probe-failed', reason: detail }, null),
      terminalLogin,
    })
  }

  const availability = await probeClaudeCliAuth({ configDir })
  return jsonResponse({ ...classifyClaudeCliStatus(platform, availability, configDir), terminalLogin })
}

// ---------------------------------------------------------------------------
// Pure classification — factored out so it's testable without a real binary,
// a real database, or a real authenticated request (see claudeCliStatus.test.ts).
// ---------------------------------------------------------------------------

/**
 * Combine a platform-support result and a probe result into the wire shape.
 * `configDir` is only needed to build the L1 login command, and only when the
 * platform is supported (the login command is meaningless on an unsupported
 * host, where there is no config dir to point it at).
 */
export function classifyClaudeCliStatus(
  platform: ClaudeCliPlatformSupport,
  availability: ClaudeCliAvailability | null,
  configDir: string | null,
): ClaudeCliClassification {
  if (!platform.supported) {
    return { availability: 'unsupported', reason: platform.reason }
  }
  if (!availability) {
    // Defensive — platform is supported but no probe result was supplied.
    // Only reachable from the config-dir-preparation failure path above.
    return { availability: 'probe-failed', reason: 'Claude CLI status could not be determined.' }
  }

  switch (availability.status) {
    case 'logged-in':
      return {
        availability: 'logged-in',
        ...(availability.authStatus.subscriptionType
          ? { subscriptionType: availability.authStatus.subscriptionType }
          : {}),
      }
    case 'logged-out':
      return {
        availability: 'logged-out',
        reason: 'Not logged in to the Claude CLI yet.',
        ...(configDir ? { loginCommand: buildClaudeCliLoginCommand(configDir) } : {}),
      }
    case 'not-installed':
      return {
        availability: 'not-installed',
        reason: 'The `claude` CLI is not installed on this host.',
      }
    case 'probe-failed':
      return {
        availability: 'probe-failed',
        reason: availability.reason,
        ...(configDir ? { loginCommand: buildClaudeCliLoginCommand(configDir) } : {}),
      }
  }
}
