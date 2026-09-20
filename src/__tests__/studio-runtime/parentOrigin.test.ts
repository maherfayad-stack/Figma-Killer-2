/**
 * `resolveParentOrigin` — how a live frame decides whether, and to whom, it
 * talks. The allowlist (`STUDIO_PARENT_ORIGINS`, Studio's `liveFrameAncestors`)
 * says who MAY be a parent; `document.referrer` says which one IS.
 */
import { describe, expect, it } from 'bun:test'
import { readStudioRuntimeConfigFromEnv, STUDIO_PARENT_ORIGINS_ENV } from '@core/studio-runtime'
import { resolveParentOrigin } from '../../core/studio-runtime/runtime'

const ALLOWED = ['http://localhost:5174', 'http://127.0.0.1:3001', 'https://studio.example.com']

describe('resolveParentOrigin', () => {
  it('picks the allowed origin that framed the document, from the referrer', () => {
    expect(resolveParentOrigin(ALLOWED, 'http://127.0.0.1:3001/admin/site?page=home')).toBe('http://127.0.0.1:3001')
    expect(resolveParentOrigin(ALLOWED, 'https://studio.example.com/')).toBe('https://studio.example.com')
  })

  it('answers null for a plain tab (no referrer), a framer not on the list, or a garbage referrer', () => {
    expect(resolveParentOrigin(ALLOWED, '')).toBeNull()
    expect(resolveParentOrigin(ALLOWED, 'https://evil.example/')).toBeNull()
    expect(resolveParentOrigin(ALLOWED, 'not a url')).toBeNull()
    expect(resolveParentOrigin([], 'http://127.0.0.1:3001/')).toBeNull()
  })

  it('reads the comma-separated allowlist the dev-server manager sets on the process', () => {
    const config = readStudioRuntimeConfigFromEnv({ [STUDIO_PARENT_ORIGINS_ENV]: ' http://localhost:5174, http://127.0.0.1:3001 ,' }, 'data-node-id')
    expect(config.parentOrigins).toEqual(['http://localhost:5174', 'http://127.0.0.1:3001'])
    expect(readStudioRuntimeConfigFromEnv({}, 'data-node-id').parentOrigins).toEqual([])
  })
})
