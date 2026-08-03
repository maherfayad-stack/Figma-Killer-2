/**
 * Studio MCP tools must resolve their optional `dir` through
 * `resolveToolProjectDir(dirInput, ctx)`, never through the bare
 * `resolveProjectDir`.
 *
 * `resolveProjectDir(undefined)` answers with the first project in
 * ALPHABETICAL order. That was harmless while a workspace held one project and
 * silently wrong the moment it held two: an agent that omitted `dir` — which
 * it does by default, since every tool documents the parameter as optional —
 * read and wrote `untitled` while the human was looking at `untitled-2`. Every
 * call succeeded and returned real data about a project the user could not
 * see, which is indistinguishable from the agent "remembering" the wrong
 * workspace.
 *
 * `resolveToolProjectDir` closes it by defaulting to the turn's own open
 * project (`ctx.workspaceDir`) before falling back. This gate exists because
 * the failure is invisible in review: a bare `resolveProjectDir(dirInput)`
 * looks correct, type-checks, and passes every test that only ever has one
 * project on disk.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const TOOLS_DIR = join(import.meta.dir, '../../../server/ai/mcp/tools/studio')

/** The resolver itself is the one legitimate caller — it is the wrapper. */
const ALLOWLIST = new Set(['resolveToolProjectDir.ts'])

function toolSourceFiles(): string[] {
  return readdirSync(TOOLS_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .filter((name) => !ALLOWLIST.has(name))
}

describe('Studio MCP tools resolve dir against the open workspace', () => {
  it('no tool module calls resolveProjectDir directly', () => {
    const offenders: string[] = []
    for (const name of toolSourceFiles()) {
      const source = readFileSync(join(TOOLS_DIR, name), 'utf8')
      // Word-boundary-anchored so `resolveToolProjectDir` never matches.
      if (/(?<![A-Za-z])resolveProjectDir\s*\(/.test(source)) offenders.push(name)
    }

    expect(offenders).toEqual([])
  })

  it('every resolveToolProjectDir call passes the tool context', () => {
    const offenders: string[] = []
    for (const name of toolSourceFiles()) {
      const source = readFileSync(join(TOOLS_DIR, name), 'utf8')
      for (const call of source.match(/resolveToolProjectDir\([^)]*\)/g) ?? []) {
        if (!/,\s*ctx\s*\)/.test(call)) offenders.push(`${name}: ${call}`)
      }
    }

    expect(offenders).toEqual([])
  })
})
