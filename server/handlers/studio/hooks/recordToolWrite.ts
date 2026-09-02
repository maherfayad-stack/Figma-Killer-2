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
 */
import { appendTurnWrite } from '../turnWriteLog'

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
    appendTurnWrite(dir, filePath)
  } catch (err) {
    console.error('[studio/hooks/recordToolWrite]', err)
  }
}

await main()
process.exit(0)
