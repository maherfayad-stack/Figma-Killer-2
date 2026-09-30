#!/usr/bin/env bun
/**
 * recordToolWrite — the `PostToolUse` hook body for a real Studio chat turn.
 *
 * Wired into the project's generated `.claude/settings.local.json`
 * (`projectGuide.ts`, matcher `Write|Edit`) as an absolute path, invoked
 * directly by the `claude` CLI as its own subprocess — see
 * `turnWriteLog.ts`'s module doc for why this exists at all (the agent
 * authors files natively; the admin server has no other signal that a write
 * happened).
 *
 * Reads the `PostToolUse` JSON Studio's own hooks reference documents on
 * stdin (`{ tool_name, tool_input: { file_path, ... }, cwd, ... }`), appends
 * one entry to `dir`'s turn-write log when `tool_input.file_path` is present,
 * and always exits 0 with no stdout — a tracking hook must never block a
 * tool call, must never show noise in the transcript, and a failure here
 * degrades to "this write was not tracked", never to a broken turn.
 *
 * WHOSE log it appends to comes from the `STUDIO_AGENT_USER_KEY` environment
 * variable the CLI inherited from `claudeCli.ts` and passes down to every
 * hook it spawns — see `agentUserScope.ts` for why the account cannot come
 * from the generated hook command instead.
 *
 * It also records the write's POST-image into the turn's checkpoint
 * (`agentCheckpoints.ts`, AI-7) — what the agent left, which a later revert
 * compares the file against before it restores anything. The pre-image was
 * taken by the `PreToolUse` hook (`denyControlPlaneWrite.ts`).
 */
import { resolve } from 'node:path'
import { appendTurnWrite } from '../turnWriteLog'
import { studioAgentUserKeyFromEnv } from '../agentUserScope'
import { conversationCheckpointKeyFromEnv, recordAgentPostImage } from '../agentCheckpoints'

interface PostToolUseInput {
  readonly tool_input?: { readonly file_path?: string }
  readonly cwd?: string
}

async function main(): Promise<void> {
  try {
    const raw = await Bun.stdin.text()
    const input = JSON.parse(raw) as PostToolUseInput
    const filePath = input.tool_input?.file_path
    const dir = input.cwd
    if (!filePath || !dir) return
    const userKey = studioAgentUserKeyFromEnv()
    appendTurnWrite(dir, userKey, filePath)
    const conversationKey = conversationCheckpointKeyFromEnv()
    if (conversationKey !== null) recordAgentPostImage(dir, userKey, conversationKey, resolve(dir, filePath))
  } catch (err) {
    console.error('[studio/hooks/recordToolWrite]', err)
  }
}

await main()
process.exit(0)
