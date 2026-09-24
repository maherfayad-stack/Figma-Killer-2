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
 *
 * ## Then the checkpoint (AI-7)
 *
 * A write the gate ALLOWS is about to happen, so this is the last moment the
 * file still holds what it held before the turn: `captureAgentPreImage` copies
 * it into the turn's checkpoint (`agentCheckpoints.ts`), which is what the
 * panel's "Revert turn" restores. Only after the gate — a refused write
 * changes nothing and needs no pre-image. Fail-soft like everything else
 * here: a checkpoint that cannot be taken leaves the file un-revertable, never
 * blocks the write. The file keeps its name because the generated
 * `.claude/settings.local.json` of every existing project points at it, and a
 * hand-edited settings file is never regenerated — renaming it would silently
 * drop the security gate from those projects.
 */
import { resolve } from 'node:path'
import { agentWriteRefusal } from '../agentWriteScope'
import { captureAgentPreImage, conversationCheckpointKeyFromEnv } from '../agentCheckpoints'
import { studioAgentUserKeyFromEnv } from '../agentUserScope'

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

  const cwd = input.cwd ?? process.cwd()
  const refusal = agentWriteRefusal(filePath, cwd)
  if (refusal === null) {
    const conversationKey = conversationCheckpointKeyFromEnv()
    if (conversationKey !== null) {
      captureAgentPreImage(cwd, studioAgentUserKeyFromEnv(), conversationKey, resolve(cwd, filePath))
    }
    return 0
  }

  console.error(refusal.message)
  return 2
}

process.exit(await main())
