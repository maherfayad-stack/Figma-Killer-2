/**
 * Claude CLI "log in with Claude" launch — POST /admin/api/ai/providers/claude-cli/login-terminal
 *
 * Opens a detached terminal window, on THIS host, running `claude auth
 * login` with the caller's own per-user `CLAUDE_CONFIG_DIR` already set —
 * see `server/ai/drivers/claudeCliTerminalLaunch.ts` for the mechanics and
 * what was actually verified. The dialog polls the existing
 * `GET .../claude-cli/status` endpoint afterward; this route only launches.
 *
 * Always 200 with `{ ok, reason? }`, never a 4xx/5xx for an "expected"
 * unavailability (not loopback, unsupported platform, no terminal found) —
 * same pattern as `POST /credentials/:id/test`, so the dialog can render the
 * reason inline instead of branching on `ApiError`.
 */

import { jsonResponse } from '../../http'
import { requireCapability } from '../../auth/authz'
import { isLoopbackRequest } from '../../auth/security'
import type { DbClient } from '../../db/client'
import {
  claudeCliPlatformSupport,
  ensureClaudeCliConfigDir,
  resolveClaudeCliDataRoot,
} from '../../handlers/studio/claudeCliEnv'
import { launchClaudeCliLoginTerminal, resolveTerminalLaunchSupport } from '../drivers/claudeCliTerminalLaunch'

export function tryHandleAiClaudeCliLoginTerminal(
  req: Request,
  db: DbClient,
  pathname: string,
): Promise<Response> | null {
  if (pathname !== '/admin/api/ai/providers/claude-cli/login-terminal') return null
  return handleLoginTerminal(req, db)
}

async function handleLoginTerminal(req: Request, db: DbClient): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
  }
  const userOrResponse = await requireCapability(req, db, 'ai.providers.manage')
  if (userOrResponse instanceof Response) return userOrResponse

  const support = resolveTerminalLaunchSupport(process.platform, isLoopbackRequest(req))
  if (!support.available) {
    return jsonResponse({ ok: false, reason: support.reason })
  }

  // Redundant with `resolveTerminalLaunchSupport`'s own darwin branch, but
  // asserted again directly against the same platform-support check the
  // status endpoint uses — a future platform-support change only has to stay
  // correct in one place (`claudeCliEnv.ts`) to keep both callers honest.
  const platform = claudeCliPlatformSupport()
  if (!platform.supported) {
    return jsonResponse({ ok: false, reason: platform.reason })
  }

  let configDir: string
  try {
    configDir = ensureClaudeCliConfigDir(resolveClaudeCliDataRoot(), userOrResponse.id)
  } catch (err) {
    console.error('[ai/claudeCliLoginTerminal] config dir preparation failed:', err)
    return jsonResponse({ ok: false, reason: 'Could not prepare a login directory for this account.' })
  }

  const result = await launchClaudeCliLoginTerminal({ configDir })
  return jsonResponse(result)
}
