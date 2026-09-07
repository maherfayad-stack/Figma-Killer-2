/**
 * `connectorWorkspace` + `resolveToolProjectDir` — the fix for a Studio tool
 * silently operating on the wrong project.
 *
 * The behaviour under test is a precedence rule, so every case here is about
 * which of the three sources wins:
 *   explicit `dir` → this turn's open project → first project alphabetically.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getConnectorWorkspace, registerConnectorWorkspace } from './connectorWorkspace'
import { resolveToolProjectDir } from './tools/studio/resolveToolProjectDir'

describe('registerConnectorWorkspace', () => {
  it('binds a workspace to a connector and releases it', () => {
    const release = registerConnectorWorkspace('conn-1', '/w/untitled-2')
    expect(getConnectorWorkspace('conn-1')).toBe('/w/untitled-2')

    release()
    expect(getConnectorWorkspace('conn-1')).toBeUndefined()
  })

  it('is undefined for a connector that never bound one', () => {
    expect(getConnectorWorkspace('conn-never')).toBeUndefined()
  })

  it('a stale release does not unbind a newer turn on the same connector id', () => {
    // A session connector id can be reused across turns; a late `finally` from
    // the finished turn must not blank the live one.
    const releaseOld = registerConnectorWorkspace('conn-2', '/w/old')
    registerConnectorWorkspace('conn-2', '/w/new')

    releaseOld()

    expect(getConnectorWorkspace('conn-2')).toBe('/w/new')
  })
})

describe('resolveToolProjectDir', () => {
  // Real directories inside a real workspace root: since W10 every `dir` is
  // containment-checked against `projectsRootDir()`, so a made-up `/w/…` path
  // is refused before precedence is ever consulted.
  const previousRoot = process.env.STUDIO_WORKSPACE_DIR
  let open = ''

  beforeAll(() => {
    const root = mkdtempSync(join(tmpdir(), 'connector-workspace-'))
    process.env.STUDIO_WORKSPACE_DIR = root
    open = join(root, 'untitled-2')
    mkdirSync(open, { recursive: true })
  })

  afterAll(() => {
    const root = process.env.STUDIO_WORKSPACE_DIR!
    if (previousRoot === undefined) delete process.env.STUDIO_WORKSPACE_DIR
    else process.env.STUDIO_WORKSPACE_DIR = previousRoot
    rmSync(root, { recursive: true, force: true })
  })

  it('accepts an explicitly passed dir that names the open workspace', () => {
    expect(resolveToolProjectDir(open, { workspaceDir: open })).toBe(open)
  })

  it('falls back to the turn workspace when the caller passed no dir', () => {
    // This is the whole fix: an omitted `dir` used to mean "first project
    // alphabetically", which is how an agent ended up in `untitled` while the
    // user was in `untitled-2`.
    expect(resolveToolProjectDir(undefined, { workspaceDir: open })).toBe(open)
    expect(resolveToolProjectDir(null, { workspaceDir: open })).toBe(open)
  })

  it('with neither, defers to resolveProjectDir rather than returning undefined', () => {
    // No open workspace and no explicit dir — the historical path. Asserting
    // only that it still yields an absolute string, since the actual answer
    // depends on what is on disk in this checkout.
    const dir = resolveToolProjectDir(undefined, {})
    expect(typeof dir).toBe('string')
    expect(dir.startsWith('/')).toBe(true)
  })

  // A bound connector naming a DIFFERENT project is refused, and a `dir`
  // outside the workspace root is refused outright — both live in
  // `src/__tests__/architecture/studio-tool-project-dir.test.ts`, next to the
  // gate that keeps every tool routed through this resolver in the first
  // place.
})
