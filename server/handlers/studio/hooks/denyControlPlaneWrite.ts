#!/usr/bin/env bun
/**
 * denyControlPlaneWrite — the `claude` CLI's `PreToolUse`(`Write|Edit`) hook
 * body for a real Studio chat turn.
 *
 * Wired into the project's generated `.claude/settings.local.json`
 * (`projectGuide.ts`) as an absolute path, invoked by the CLI as its own
 * subprocess BEFORE the tool call runs. Exit 2 is the documented blocking
 * contract for `PreToolUse`: the call does not happen and stderr is fed back
 * to the model, which is why the refusal text below is written for the model
 * to read and act on rather than for a log.
 *
 * `agentWriteScope.ts` owns the decision and the full reasoning — in one
 * line: `.studio/`, `.claude/` and `.git/` are Studio's own control plane,
 * living inside the same directory the subprocess's `cwd` containment allows
 * it to write. Without this, an agent could promote its project to Tier 2 by
 * editing `.studio/meta.json` and then call the Tier-2 tools A10 just made
 * reachable — manufacturing the exact consent that gate is built on.
 *
 * ## Fails OPEN, deliberately
 *
 * Unreadable or unparseable stdin means the CLI's hook contract changed, not
 * that a write is hostile — the payload is the CLI's own, never the model's.
 * A gate that blocked every write the moment its input shape drifted would
 * wedge the product, so this logs and allows, matching `recordToolWrite.ts`
 * and `stopGateCheck.ts`. This is defence in depth on one surface (the only
 * one that grants native file writes), not the last line anywhere.
 */
import { agentWriteRefusalReason } from '../agentWriteScope'

interface PreToolUseInput {
  readonly tool_input?: { readonly file_path?: string }
  readonly cwd?: string
}

/** Exit code: `2` blocks the tool call, `0` allows it. */
async function main(): Promise<number> {
  let input: PreToolUseInput
  try {
    input = JSON.parse(await Bun.stdin.text()) as PreToolUseInput
  } catch (err) {
    console.error('[studio/hooks/denyControlPlaneWrite] could not read stdin — allowing the write:', err)
    return 0
  }

  const filePath = input.tool_input?.file_path
  if (!filePath) return 0

  const reason = agentWriteRefusalReason(filePath, input.cwd ?? process.cwd())
  if (reason === null) return 0

  console.error(reason)
  return 2
}

process.exit(await main())
