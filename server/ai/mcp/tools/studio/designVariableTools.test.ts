/**
 * studio_ingest_design_variables / studio_list_design_variables /
 * studio_read_design_variable_set / studio_delete_design_variable_set —
 * handler coverage against a real temp project directory, plus the TypeBox
 * boundary against malformed/hostile input (the same defence-in-depth layer
 * `executeAiTool` applies to every MCP tool call via `parseValue`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseValue } from '@core/utils/typeboxHelpers'
import { studioDesignVariableMcpTools } from './designVariableTools'
import { studioDesignReferenceMcpTools } from './designReferenceTools'
import { MAX_VARIABLES_PER_INGEST } from '../../../../handlers/studio/designVariableSchema'

function tool(name: string) {
  const t = studioDesignVariableMcpTools.find((tt) => tt.name === name)
  if (!t) throw new Error(`tool not found: ${name}`)
  return t
}

function referenceTool(name: string) {
  const t = studioDesignReferenceMcpTools.find((tt) => tt.name === name)
  if (!t) throw new Error(`reference tool not found: ${name}`)
  return t
}

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-design-variable-tools-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('tool shapes', () => {
  it('ingest and delete are mutating and gated; list/read are not', () => {
    expect(tool('studio_ingest_design_variables').mutates).toBe(true)
    expect(tool('studio_ingest_design_variables').requiredCapabilities).toEqual(['studio.write'])
    expect(tool('studio_delete_design_variable_set').mutates).toBe(true)
    expect(tool('studio_delete_design_variable_set').requiredCapabilities).toEqual(['studio.write'])
    expect(tool('studio_list_design_variables').requiredCapabilities ?? []).toEqual([])
    expect(tool('studio_read_design_variable_set').requiredCapabilities ?? []).toEqual([])
    for (const name of [
      'studio_ingest_design_variables',
      'studio_list_design_variables',
      'studio_read_design_variable_set',
      'studio_delete_design_variable_set',
    ]) {
      expect(tool(name).execution).toBe('server')
    }
  })

  it('every input schema is an object at the top level with additionalProperties:false', () => {
    for (const t of studioDesignVariableMcpTools) {
      expect(t.inputSchema.type).toBe('object')
      expect((t.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false)
    }
  })
})

describe('the TypeBox boundary — malformed and hostile ingest input is rejected before the handler runs', () => {
  const schema = tool('studio_ingest_design_variables').inputSchema

  it('accepts a well-formed payload', () => {
    expect(() =>
      parseValue(schema, { source: 'test', variables: [{ name: 'a', value: '#000' }] }),
    ).not.toThrow()
  })

  it('rejects a missing required field (source)', () => {
    expect(() => parseValue(schema, { variables: [{ name: 'a', value: '#000' }] })).toThrow()
  })

  it('rejects zero variables (minItems:1) — an ingest call must ingest something', () => {
    expect(() => parseValue(schema, { source: 'test', variables: [] })).toThrow()
  })

  it('rejects an absurd entry count above MAX_VARIABLES_PER_INGEST', () => {
    const variables = Array.from({ length: MAX_VARIABLES_PER_INGEST + 1 }, (_, i) => ({ name: `v${i}`, value: '#000' }))
    expect(() => parseValue(schema, { source: 'test', variables })).toThrow()
  })

  it('accepts exactly MAX_VARIABLES_PER_INGEST entries', () => {
    const variables = Array.from({ length: MAX_VARIABLES_PER_INGEST }, (_, i) => ({ name: `v${i}`, value: '#000' }))
    expect(() => parseValue(schema, { source: 'test', variables })).not.toThrow()
  })

  it('rejects an oversized value string', () => {
    expect(() =>
      parseValue(schema, { source: 'test', variables: [{ name: 'a', value: 'x'.repeat(100_000) }] }),
    ).toThrow()
  })

  it('rejects an oversized name string', () => {
    expect(() =>
      parseValue(schema, { source: 'test', variables: [{ name: 'n'.repeat(10_000), value: '#000' }] }),
    ).toThrow()
  })

  it('rejects a value that is an object or array — only string/number/boolean are accepted', () => {
    expect(() =>
      parseValue(schema, { source: 'test', variables: [{ name: 'a', value: { nested: true } }] }),
    ).toThrow()
    expect(() =>
      parseValue(schema, { source: 'test', variables: [{ name: 'a', value: [1, 2, 3] }] }),
    ).toThrow()
  })

  it('accepts a numeric value (a FLOAT variable forwarded as JSON, not stringified)', () => {
    expect(() => parseValue(schema, { source: 'test', variables: [{ name: 'a', value: 16 }] })).not.toThrow()
  })

  it('an absurdly large number outside the Number branch\'s bounds is NOT silently accepted as a huge px value', () => {
    // TypeBox's `Value.Parse` (Default+Convert+Clean+Decode+Check) tries each
    // union member in turn: the Number branch's `maximum` rejects 1e300, so
    // Convert falls through to the String branch and the value survives as
    // the STRING "1e+300" instead of throwing. That is still safe — this
    // repo's own `normalizeDesignVariableValue` (see designVariableNormalize
    // .test.ts's "scientific notation" case) refuses to read scientific
    // notation as a bare number, so it lands as kind:"other", never a
    // fabricated huge length. This test documents that coercion rather than
    // asserting a throw that does not happen.
    const parsed = parseValue(schema, { source: 'test', variables: [{ name: 'a', value: 1e300 }] }) as {
      variables: Array<{ value: unknown }>
    }
    expect(typeof parsed.variables[0]!.value).toBe('string')
  })

  it('strips an unknown top-level field rather than throwing (Clean runs before Check) — the field never reaches the handler', () => {
    const parsed = parseValue(schema, {
      source: 'test',
      variables: [{ name: 'a', value: '#000' }],
      dangerousExtra: 'should not survive',
    }) as Record<string, unknown>
    expect('dangerousExtra' in parsed).toBe(false)
  })

  it('strips an unknown field on one variable entry rather than throwing', () => {
    const parsed = parseValue(schema, {
      source: 'test',
      variables: [{ name: 'a', value: '#000', extra: 'nope' }],
    }) as { variables: Array<Record<string, unknown>> }
    expect('extra' in parsed.variables[0]!).toBe(false)
  })
})

describe('studio_ingest_design_variables handler', () => {
  it('ingests, normalises, and reports counts', async () => {
    const result = (await tool('studio_ingest_design_variables').handler!(
      {
        dir,
        source: 'figma get_variable_defs on https://figma.example/file/abc',
        variables: [
          { name: 'coral/100', value: '#EF4550' },
          { name: 'spacing/md', value: 16 },
          { name: 'font/family', value: 'Inter' },
        ],
      },
      {} as never,
    )) as { ok: boolean; set: { variableCount: number }; colorCount: number; sizeCount: number; otherCount: number }

    expect(result.ok).toBe(true)
    expect(result.set.variableCount).toBe(3)
    expect(result.colorCount).toBe(1)
    expect(result.sizeCount).toBe(1)
    expect(result.otherCount).toBe(1)
  })

  it('refuses an unknown referenceId with a clear, actionable error rather than silently ingesting unscoped', async () => {
    const result = (await tool('studio_ingest_design_variables').handler!(
      { dir, source: 'test', referenceId: 'does-not-exist', variables: [{ name: 'a', value: '#000' }] },
      {} as never,
    )) as { ok: boolean; error?: string }

    expect(result.ok).toBe(false)
    expect(result.error).toContain('does-not-exist')
    expect(result.error).toContain('studio_register_design_reference')
  })

  it('accepts a referenceId that is actually registered', async () => {
    const sharp = (await import('sharp')).default
    const png = await sharp({ create: { width: 10, height: 10, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } })
      .png()
      .toBuffer()
    const registered = (await referenceTool('studio_register_design_reference').handler!(
      { dir, imageBase64: png.toString('base64') },
      {} as never,
    )) as { ok: boolean; reference: { id: string } }
    expect(registered.ok).toBe(true)

    const result = (await tool('studio_ingest_design_variables').handler!(
      { dir, source: 'test', referenceId: registered.reference.id, variables: [{ name: 'a', value: '#000' }] },
      {} as never,
    )) as { ok: boolean; set: { referenceId?: string } }
    expect(result.ok).toBe(true)
    expect(result.set.referenceId).toBe(registered.reference.id)
  })
})

describe('studio_list_design_variables / studio_read_design_variable_set / studio_delete_design_variable_set', () => {
  it('list -> read -> delete round trip', async () => {
    const ingested = (await tool('studio_ingest_design_variables').handler!(
      { dir, source: 'test', variables: [{ name: 'coral/100', value: '#EF4550' }] },
      {} as never,
    )) as { ok: boolean; set: { id: string } }

    const listed = (await tool('studio_list_design_variables').handler!({ dir }, {} as never)) as {
      ok: boolean
      totalCount: number
      sets: Array<{ id: string; variableCount: number }>
    }
    expect(listed.totalCount).toBe(1)
    expect(listed.sets[0]!.id).toBe(ingested.set.id)
    expect(listed.sets[0]!.variableCount).toBe(1)

    const read = (await tool('studio_read_design_variable_set').handler!(
      { dir, setId: ingested.set.id },
      {} as never,
    )) as { ok: boolean; variables: Array<{ name: string; hex?: string }> }
    expect(read.ok).toBe(true)
    expect(read.variables[0]!.name).toBe('coral/100')
    expect(read.variables[0]!.hex).toBe('#ef4550')

    const deleted = (await tool('studio_delete_design_variable_set').handler!(
      { dir, setId: ingested.set.id },
      {} as never,
    )) as { ok: boolean; removed: boolean }
    expect(deleted.removed).toBe(true)

    const readAfterDelete = (await tool('studio_read_design_variable_set').handler!(
      { dir, setId: ingested.set.id },
      {} as never,
    )) as { ok: boolean; error?: string }
    expect(readAfterDelete.ok).toBe(false)
  })

  it('delete is idempotent', async () => {
    const first = (await tool('studio_delete_design_variable_set').handler!(
      { dir, setId: 'never-existed' },
      {} as never,
    )) as { ok: boolean; removed: boolean }
    expect(first.ok).toBe(true)
    expect(first.removed).toBe(false)
  })

  it('read filters by nameContains and caps results honestly', async () => {
    await tool('studio_ingest_design_variables').handler!(
      {
        dir,
        source: 'test',
        variables: [
          { name: 'coral/100', value: '#EF4550' },
          { name: 'coral/200', value: '#E23A45' },
          { name: 'aqua/100', value: '#0C9AB0' },
        ],
      },
      {} as never,
    )
    const ingested = (await tool('studio_list_design_variables').handler!({ dir }, {} as never)) as {
      sets: Array<{ id: string }>
    }
    const setId = ingested.sets[0]!.id

    const filtered = (await tool('studio_read_design_variable_set').handler!(
      { dir, setId, nameContains: 'coral' },
      {} as never,
    )) as { totalCount: number; returnedCount: number; variables: Array<{ name: string }> }
    expect(filtered.totalCount).toBe(2)
    expect(filtered.variables.map((v) => v.name).sort()).toEqual(['coral/100', 'coral/200'])

    const capped = (await tool('studio_read_design_variable_set').handler!(
      { dir, setId, limit: 1 },
      {} as never,
    )) as { totalCount: number; returnedCount: number; truncated: boolean; omittedCount: number }
    expect(capped.returnedCount).toBe(1)
    expect(capped.truncated).toBe(true)
    expect(capped.omittedCount).toBe(2)
  })
})
