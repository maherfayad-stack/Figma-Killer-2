/**
 * editor.ts spotlight commands.
 *
 * Covers the fix for the "Cmd+S silently does not save" bug: `editor.save`
 * used to write straight to `cmsAdapter` (the CMS database adapter) and then
 * unconditionally clear `hasUnsavedChanges` — Studio's actual source of truth
 * is the user's repository on disk, written through `fsCodemodAdapter` via
 * `usePersistence`'s save pipeline, so that write silently never landed.
 *
 * `editor.save` now goes through `flushEditorSave()` — the same bridge the
 * MCP editor-bridge uses — which calls whatever save function the mounted
 * `usePersistence` registered. These tests mount `usePersistence` with a
 * fake adapter standing in for `fsCodemodAdapter` and prove:
 *   1. running the command reaches THAT adapter, never `cmsAdapter`,
 *   2. `hasUnsavedChanges` only clears on a confirmed successful write,
 *   3. a failed write surfaces an error toast instead of failing silently.
 *
 * Also covers the `editor.publish` deletion — publishing was removed from
 * Studio; the command list must no longer include it.
 *
 * Lives here (not under `commands/__tests__/`) because
 * `spotlight-no-direct-store-mutation.test.ts` scans every file under
 * `admin/spotlight/commands/` for direct `useEditorStore.setState` /
 * store-internal imports — legitimate in a store-seeding test fixture, but
 * exactly the pattern that gate exists to keep out of the command modules
 * themselves. `commandRegistry.test.ts` / `a11y.test.ts` / `keyboardNavOrder.test.ts`
 * set the same precedent for spotlight-wide tests.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import React from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { getEditorCommands } from '../commands/editor'
import { usePersistence } from '@site/hooks/usePersistence'
import { useEditorStore } from '@site/store/store'
import { emptyDirtyMarks } from '@site/store/slices/site/dirtyTracking'
import { cmsAdapter, type CmsCurrentUser } from '@core/persistence'
import type { IPersistenceAdapter, SaveSiteOptions } from '@core/persistence/types'
import type { CommandRunContext } from '../types'
import { __resetToastBusForTests, subscribeToasts } from '@ui/components/Toast/toastBus'
import { makePage, makeSite } from '../../../__tests__/fixtures'

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeUser(): CmsCurrentUser {
  return {
    id: 'user_1',
    email: 'user@example.com',
    displayName: 'User',
    status: 'active',
    role: {
      id: 'role_1',
      slug: 'role_1',
      name: 'Role',
      description: '',
      isSystem: false,
      capabilities: ['site.structure.edit', 'site.content.edit', 'site.style.edit'],
    },
    capabilities: ['site.structure.edit', 'site.content.edit', 'site.style.edit'],
    lastLoginAt: null,
    failedLoginCount: 0,
    lockedUntil: null,
    passwordUpdatedAt: null,
    mfaEnabled: false,
    mfaEnabledAt: null,
    mfaRecoveryCodesRemaining: 0,
    stepUpAuthMode: 'required',
    stepUpWindowMinutes: 15,
    avatarMediaId: null,
    avatarUrl: null,
    gravatarHash: '',
    createdAt: '2026-05-18T00:00:00.000Z',
    updatedAt: '2026-05-18T00:00:00.000Z',
  } as unknown as CmsCurrentUser
}

function makeCtx(): CommandRunContext & { closed: boolean } {
  const ctx = {
    workspace: 'site' as const,
    pathname: '/admin/site',
    user: makeUser(),
    args: {},
    navigate: () => {},
    closeSpotlight: () => { ctx.closed = true },
    pushScope: () => {},
    popScope: () => {},
    runStepUp: async <T>(action: () => Promise<T>) => action(),
    closed: false,
  }
  return ctx
}

interface RecordedSave {
  dirty: SaveSiteOptions['dirty']
}

/** Fake adapter standing in for `fsCodemodAdapter` — records every save. */
function makeFsAdapter(shouldFail: boolean): { adapter: IPersistenceAdapter; saves: RecordedSave[] } {
  const saves: RecordedSave[] = []
  const adapter: IPersistenceAdapter = {
    loadSite: async () => undefined,
    saveSite: async (_site, opts = {}) => {
      saves.push({ dirty: opts.dirty })
      if (shouldFail) throw new Error('disk write failed')
    },
  }
  return { adapter, saves }
}

function HookHost({ adapter }: { adapter: IPersistenceAdapter }) {
  usePersistence('default', adapter, { enabled: true })
  return null
}

function mountUsePersistence(adapter: IPersistenceAdapter): void {
  // `render()` flushes mount effects synchronously (wrapped in `act()`), so
  // `registerEditorSave` (a plain, non-async effect) has already run by the
  // time this returns.
  render(React.createElement(HookHost, { adapter }))
}

function seedStore(): void {
  useEditorStore.setState({
    _historyPast: [],
    _historyFuture: [],
    _historyCoalesceKey: null,
    hasUnsavedChanges: false,
    _dirtySave: emptyDirtyMarks(),
  } as Parameters<typeof useEditorStore.setState>[0])
  useEditorStore.getState().loadSite(
    makeSite({ pages: [makePage({ id: 'page-a', slug: 'index', title: 'Home' })] }),
  )
  useEditorStore.setState({ activePageId: 'page-a' })
  useEditorStore.getState().updateNodeProps('root', { text: `edit-${Math.random()}` })
}

afterEach(cleanup)

// ─── editor.publish is gone ────────────────────────────────────────────────────

describe('getEditorCommands', () => {
  it('no longer exposes editor.publish — Studio has no publish step', () => {
    const ids = getEditorCommands().map((c) => c.id)
    expect(ids).toEqual(['editor.save', 'editor.undo', 'editor.redo'])
  })
})

// ─── editor.save ────────────────────────────────────────────────────────────

describe('editor.save', () => {
  it('reaches the mounted save pipeline (fsCodemodAdapter stand-in), never cmsAdapter, and clears hasUnsavedChanges on success', async () => {
    __resetToastBusForTests()
    seedStore()
    expect(useEditorStore.getState().hasUnsavedChanges).toBe(true)

    const cmsSpy = spyOn(cmsAdapter, 'saveSite')
    const { adapter, saves } = makeFsAdapter(false)
    mountUsePersistence(adapter)

    const command = getEditorCommands().find((c) => c.id === 'editor.save')!
    const ctx = makeCtx()
    await command.run(ctx)

    expect(saves).toHaveLength(1)
    expect(cmsSpy).not.toHaveBeenCalled()
    expect(ctx.closed).toBe(true)
    await waitFor(() => expect(useEditorStore.getState().hasUnsavedChanges).toBe(false))

    cmsSpy.mockRestore()
  })

  it('surfaces an error toast and leaves hasUnsavedChanges set when the underlying save throws', async () => {
    __resetToastBusForTests()
    seedStore()

    const { adapter } = makeFsAdapter(true)
    mountUsePersistence(adapter)

    let latestToasts: ReadonlyArray<{ kind: string; title: string }> = []
    const unsubscribe = subscribeToasts((toasts) => { latestToasts = toasts })

    const command = getEditorCommands().find((c) => c.id === 'editor.save')!
    const ctx = makeCtx()
    // Must not throw out of the command — failures are caught and toasted.
    await command.run(ctx)

    expect(useEditorStore.getState().hasUnsavedChanges).toBe(true)
    expect(latestToasts).toHaveLength(1)
    expect(latestToasts[0]?.kind).toBe('error')
    expect(latestToasts[0]?.title).toBe('Save failed')

    unsubscribe()
  })
})
