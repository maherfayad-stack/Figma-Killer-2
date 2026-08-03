/**
 * `connectorWorkspace` + `resolveToolProjectDir` — the fix for a Studio tool
 * silently operating on the wrong project.
 *
 * The behaviour under test is a precedence rule, so every case here is about
 * which of the three sources wins:
 *   explicit `dir` → this turn's open project → first project alphabetically.
 */
import { describe, expect, it } from 'bun:test'
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
  it('prefers an explicitly passed dir over the open workspace', () => {
    const dir = resolveToolProjectDir('/w/explicit', { workspaceDir: '/w/open' })
    expect(dir).toBe('/w/explicit')
  })

  it('falls back to the turn workspace when the caller passed no dir', () => {
    // This is the whole fix: an omitted `dir` used to mean "first project
    // alphabetically", which is how an agent ended up in `untitled` while the
    // user was in `untitled-2`.
    expect(resolveToolProjectDir(undefined, { workspaceDir: '/w/untitled-2' })).toBe('/w/untitled-2')
    expect(resolveToolProjectDir(null, { workspaceDir: '/w/untitled-2' })).toBe('/w/untitled-2')
  })

  it('does not fall back to the workspace when a dir is given, even a surprising one', () => {
    expect(resolveToolProjectDir('/w/other', { workspaceDir: '/w/untitled-2' })).toBe('/w/other')
  })

  it('with neither, defers to resolveProjectDir rather than returning undefined', () => {
    // No open workspace and no explicit dir — the historical path. Asserting
    // only that it still yields an absolute string, since the actual answer
    // depends on what is on disk in this checkout.
    const dir = resolveToolProjectDir(undefined, {})
    expect(typeof dir).toBe('string')
    expect(dir.startsWith('/')).toBe(true)
  })
})
