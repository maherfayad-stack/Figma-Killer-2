#!/usr/bin/env bun
/**
 * stopGateCheck — the `claude` CLI's `Stop` hook body for a real Studio chat
 * turn (verification-gate item 2, "the core fix").
 *
 * Wired into the project's generated `.claude/settings.local.json`
 * (`projectGuide.ts`) as an absolute path, invoked directly by the CLI as its
 * own subprocess right as the agent is about to end its turn — see the
 * hooks reference this was verified against (`Stop`/`SubagentStop Decision
 * Control`): printing `{"decision":"block","reason":"..."}` to stdout and
 * exiting 0 makes the CLI feed `reason` back to the model as a synthetic user
 * turn and continue, instead of ending. This was confirmed against a real
 * `claude -p` run in this environment (not read from docs alone) — a Stop
 * hook printing that shape genuinely re-prompts the model mid-turn, headless,
 * with no interactive `/hooks` review gate in the way.
 *
 * ## What it blocks on
 *
 * Every page `pageWriteVerification.ts` reports as written this turn AND not
 * `verifiedSinceWrite` — no design reference registered, or a write that
 * happened after the last passing `studio_compare`. Silent (exit 0, no
 * stdout) for every other case: nothing written this turn, or everything
 * written this turn already passed a compare that postdates it.
 *
 * ## Why this can only ever nudge once per stop attempt
 *
 * `stop_hook_active` is `true` on the Stop event that fires AFTER this hook
 * already blocked once and the model responded — checked first, unconditionally,
 * and always allowed through. A gate the model can never actually satisfy (no
 * browser connected, a Figma connector that never responds) must still let the
 * turn end rather than loop forever; the 19-minute session this whole feature
 * exists to prevent was already an unbounded loop of a DIFFERENT shape, and
 * this hook must never become a second one.
 *
 * ## Fails open
 *
 * Any error (unreadable stdin, a project this deep into a broken state that
 * `loadStudioPages` throws) is logged to stderr and swallowed — exit 0, no
 * block. A broken gate must never trap the user in a turn that can't end.
 */
import { loadStudioPages } from '../../studioPageLoad'
import { computePageWriteVerification, describeUnverifiedPage } from '../pageWriteVerification'
import { buildStudioCapabilityDigest } from '../../../ai/tools/studio/liveDigest'

interface StopHookInput {
  readonly stop_hook_active?: boolean
  readonly cwd?: string
}

async function main(): Promise<void> {
  let input: StopHookInput
  try {
    input = JSON.parse(await Bun.stdin.text()) as StopHookInput
  } catch (err) {
    console.error('[studio/hooks/stopGateCheck] could not read stdin — allowing stop:', err)
    return
  }

  // Never block twice in the same stop cycle — see module doc.
  if (input.stop_hook_active) return

  const dir = input.cwd
  if (!dir) return

  try {
    const { pages } = await loadStudioPages(dir)
    const entries = computePageWriteVerification(dir, pages)
    const blocking = entries.filter((e) => !e.verifiedSinceWrite)
    if (blocking.length === 0) return

    const figmaConfigured = buildStudioCapabilityDigest(dir).figma.status === 'configured'
    const reason = [
      blocking.length === 1
        ? 'One screen written this turn is not yet verified:'
        : `${blocking.length} screens written this turn are not yet verified:`,
      ...blocking.map((e) => describeUnverifiedPage(e, figmaConfigured)),
    ].join('\n')

    console.log(JSON.stringify({ decision: 'block', reason }))
  } catch (err) {
    console.error('[studio/hooks/stopGateCheck] gate check failed — allowing stop:', err)
  }
}

await main()
process.exit(0)
