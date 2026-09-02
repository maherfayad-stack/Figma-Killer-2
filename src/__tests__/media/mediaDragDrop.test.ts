import { afterEach, describe, expect, it } from 'bun:test'
import {
  clearActiveMediaDragPayload,
  hasMediaDropData,
  readActiveMediaDragPayload,
  readMediaDropPayload,
  writeMediaAssetDragData,
  writeMediaFolderDragData,
} from '@admin/shared/media/utils/mediaDragDrop'
import { canAcceptDrop, type MediaDndTarget } from '@admin/shared/media/utils/mediaDnd'
import type { CmsMediaFolder } from '@core/persistence/cmsMedia'

/**
 * A `DataTransfer` stand-in that reproduces the HTML drag-and-drop spec's
 * "protected mode": during `dragover`, `getData()` is REQUIRED to return
 * `""` while `types` stays readable. Real browsers behave this way; jsdom/
 * happy-dom's `DataTransfer` does not enforce it, which is exactly why the
 * bug this test guards (0.10 / audit G17) shipped without a failing test —
 * `src/__tests__/media/mediaDnd.test.ts` only ever exercised `canAcceptDrop`
 * with a real payload, never the protected-mode path.
 */
class ProtectedModeDataTransfer {
  private store = new Map<string, string>()
  effectAllowed = 'none'
  dropEffect = 'none'

  setData(type: string, value: string) {
    this.store.set(type, value)
  }

  /** Protected mode: always "", matching real `dragover` behaviour. */
  getData(_type: string): string {
    return ''
  }

  get types(): string[] {
    return Array.from(this.store.keys())
  }
}

function folder(overrides: Partial<CmsMediaFolder> = {}): CmsMediaFolder {
  return {
    id: 'folder_root',
    parentId: null,
    name: 'root',
    slug: 'root',
    sortOrder: 0,
    createdByUserId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

const FOLDER_A = folder({ id: 'a', parentId: null, name: 'a' })
const FOLDER_B = folder({ id: 'b', parentId: 'a', name: 'b' })

function makeTarget(): MediaDndTarget {
  const folders = [FOLDER_A, FOLDER_B]
  return {
    folders,
    folderById: new Map(folders.map((f) => [f.id, f])),
    moveAssetsToFolder: async () => {},
    moveFolder: async () => null,
  }
}

afterEach(() => {
  clearActiveMediaDragPayload()
})

describe('media drag session mirror (0.10 — protected-mode dragover)', () => {
  it('getData() is unreadable during dragover, matching the HTML DnD spec', () => {
    const dataTransfer = new ProtectedModeDataTransfer() as unknown as DataTransfer
    writeMediaFolderDragData(dataTransfer, 'b')

    // `types` (used by `hasMediaDropData`) IS readable during dragover.
    expect(hasMediaDropData(dataTransfer)).toBe(true)
    // `getData()` is NOT — this is the root cause: reading the payload this
    // way during `dragover` always fails.
    expect(readMediaDropPayload(dataTransfer)).toBeNull()
  })

  it('readActiveMediaDragPayload recovers the real payload when getData() cannot', () => {
    const dataTransfer = new ProtectedModeDataTransfer() as unknown as DataTransfer
    writeMediaFolderDragData(dataTransfer, 'b')

    expect(readMediaDropPayload(dataTransfer)).toBeNull()
    expect(readActiveMediaDragPayload()).toEqual({ kind: 'folder', folderId: 'b' })
  })

  it('an illegal folder self-drop no longer highlights as valid during dragover', () => {
    const dataTransfer = new ProtectedModeDataTransfer() as unknown as DataTransfer
    writeMediaFolderDragData(dataTransfer, 'b')
    const target = makeTarget()

    // Before the fix: `canAcceptDrop(target, readMediaDropPayload(dataTransfer), 'b')`
    // === `canAcceptDrop(target, null, 'b')` === `true` (illegal self-drop
    // highlighted as a valid target). The session mirror fixes this.
    const legalUnderOldPath = canAcceptDrop(target, readMediaDropPayload(dataTransfer), 'b')
    expect(legalUnderOldPath).toBe(true) // documents the bug's mechanism

    const legalUnderFix = canAcceptDrop(target, readActiveMediaDragPayload(), 'b')
    expect(legalUnderFix).toBe(false)
  })

  it('a legal folder move still highlights as valid during dragover', () => {
    const dataTransfer = new ProtectedModeDataTransfer() as unknown as DataTransfer
    writeMediaFolderDragData(dataTransfer, 'b')
    const target = makeTarget()

    // b -> root (null) is legal: not self, not b's current parent, not a cycle.
    expect(canAcceptDrop(target, readActiveMediaDragPayload(), null)).toBe(true)
  })

  it('asset drags mirror their payload the same way', () => {
    const dataTransfer = new ProtectedModeDataTransfer() as unknown as DataTransfer
    writeMediaAssetDragData(dataTransfer, ['x', 'y'])

    expect(readMediaDropPayload(dataTransfer)).toBeNull()
    expect(readActiveMediaDragPayload()).toEqual({ kind: 'assets', assetIds: ['x', 'y'] })
  })

  it('clearActiveMediaDragPayload resets the session (dragend)', () => {
    const dataTransfer = new ProtectedModeDataTransfer() as unknown as DataTransfer
    writeMediaFolderDragData(dataTransfer, 'b')
    expect(readActiveMediaDragPayload()).not.toBeNull()

    clearActiveMediaDragPayload()
    expect(readActiveMediaDragPayload()).toBeNull()
  })
})
