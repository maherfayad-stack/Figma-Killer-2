/**
 * `studio_plan_variants` plans app bands for an app project (AI-12): the
 * surface comes from the project's recorded platform, else its frame widths.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBoard, createBoardsFile, upsertBoard, upsertFrame } from '@core/studio-board'
import { writeBoardsFile } from '../../../../handlers/studio/boardGeometry'
import { archetypesFor } from '../../../../handlers/studio/compositionAudit'
import { resolveArchetypeSurface, studioVariantMcpTools } from './variantTools'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-plan-variants-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function meta(value: Record<string, unknown>): void {
  mkdirSync(join(dir, '.studio'), { recursive: true })
  writeFileSync(join(dir, '.studio', 'meta.json'), JSON.stringify(value))
}

function boardWithWidths(widths: number[]): void {
  let board = createBoard('b1', 'Board 1')
  widths.forEach((width, i) => {
    board = upsertFrame(board, { id: `f${i}`, pageId: `P${i}`, x: i * 500, y: 0, width, height: 800 })
  })
  writeBoardsFile(dir, upsertBoard(createBoardsFile(), board))
}

describe('resolveArchetypeSurface', () => {
  it('follows the recorded platform first', () => {
    meta({ platform: 'mobile' })
    boardWithWidths([1440, 1440])
    expect(resolveArchetypeSurface(dir)).toBe('app')
    meta({ platform: 'web' })
    boardWithWidths([393])
    expect(resolveArchetypeSurface(dir)).toBe('web')
  })

  it('reads an imported project (no platform) by its frame widths', () => {
    boardWithWidths([393, 393, 1440])
    expect(resolveArchetypeSurface(dir)).toBe('app')
    boardWithWidths([1440, 1280, 393])
    expect(resolveArchetypeSurface(dir)).toBe('web')
  })

  it('reads a project with no board as web', () => {
    expect(resolveArchetypeSurface(dir)).toBe('web')
  })
})

describe('studio_plan_variants', () => {
  it('plans app bands for a mobile project, and says which surface it planned for', async () => {
    meta({ platform: 'mobile' })
    const tool = studioVariantMcpTools.find((t) => t.name === 'studio_plan_variants')!
    const result = (await tool.handler!({ dir, baseName: 'Checkout', brief: 'Pay for an eSIM plan.', rngSeed: 3 } as never, { userId: 'u1' } as never)) as {
      ok: boolean
      surface: string
      variants: Array<{ style: { archetypes: string[]; surface: string } }>
    }
    expect(result.ok).toBe(true)
    expect(result.surface).toBe('app')
    const appIds = new Set(archetypesFor('app').map((a) => a.id))
    for (const variant of result.variants) {
      expect(variant.style.surface).toBe('app')
      for (const id of variant.style.archetypes) expect(appIds.has(id)).toBe(true)
    }
  })
})
