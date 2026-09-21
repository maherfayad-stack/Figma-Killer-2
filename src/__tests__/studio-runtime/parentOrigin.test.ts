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

  // `live-13` — a Vite full reload leaves the referrer pointing at the frame's
  // own url; the browser's ancestor origin still names the parent.
  it('prefers the ancestor origin, and falls back to the referrer only when the ancestor is absent or not allowed', () => {
    expect(resolveParentOrigin(ALLOWED, 'http://localhost:3002/p/test4/__screen/home', 'http://127.0.0.1:3001')).toBe('http://127.0.0.1:3001')
    expect(resolveParentOrigin(ALLOWED, 'http://127.0.0.1:3001/admin/site', null)).toBe('http://127.0.0.1:3001')
    expect(resolveParentOrigin(ALLOWED, 'http://127.0.0.1:3001/admin/site', 'https://evil.example')).toBe('http://127.0.0.1:3001')
    expect(resolveParentOrigin(ALLOWED, 'http://localhost:3002/p/test4/__screen/home', 'https://evil.example')).toBeNull()
    expect(resolveParentOrigin(ALLOWED, '', 'not an origin')).toBeNull()
  })

  it('reads the comma-separated allowlist the dev-server manager sets on the process', () => {
    const config = readStudioRuntimeConfigFromEnv({ [STUDIO_PARENT_ORIGINS_ENV]: ' http://localhost:5174, http://127.0.0.1:3001 ,' }, 'data-node-id')
    expect(config.parentOrigins).toEqual(['http://localhost:5174', 'http://127.0.0.1:3001'])
    expect(readStudioRuntimeConfigFromEnv({}, 'data-node-id').parentOrigins).toEqual([])
  })
})
