import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  setMcpServerSecret,
  getMcpServerSecret,
  hasMcpServerSecret,
  deleteMcpServerSecrets,
  resolveMcpServerSecretsRoot,
  McpServerSecretKeyMismatchError,
} from './mcpServerSecretStore'

// The master key loader reads `STUDIO_SECRET_KEY` or falls back to
// `.tmp/secret.key`, auto-created on first use — same as every other secret
// test in this tree, no bespoke setup needed here.

describe('mcpServerSecretStore', () => {
  let dataRoot: string

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'mcp-server-secrets-'))
  })

  afterEach(() => {
    rmSync(dataRoot, { recursive: true, force: true })
  })

  it('round-trips a secret value through encryption', async () => {
    await setMcpServerSecret('user-1', 'my-project', 'figma', 'FIGMA_TOKEN', 'sk-super-secret', dataRoot)
    const value = await getMcpServerSecret('user-1', 'my-project', 'figma', 'FIGMA_TOKEN', dataRoot)
    expect(value).toBe('sk-super-secret')
  })

  it('never writes the plaintext value anywhere on disk', async () => {
    await setMcpServerSecret('user-1', 'my-project', 'figma', 'FIGMA_TOKEN', 'sk-super-secret-plaintext-marker', dataRoot)
    const path = join(dataRoot, 'user-1', 'my-project', 'figma.json')
    expect(existsSync(path)).toBe(true)
    const raw = readFileSync(path, 'utf8')
    expect(raw).not.toContain('sk-super-secret-plaintext-marker')
  })

  it('returns null for a field that was never set', async () => {
    const value = await getMcpServerSecret('user-1', 'my-project', 'figma', 'MISSING', dataRoot)
    expect(value).toBeNull()
  })

  it('hasMcpServerSecret reports presence without decrypting', async () => {
    expect(hasMcpServerSecret('user-1', 'my-project', 'figma', 'FIGMA_TOKEN', dataRoot)).toBe(false)
    await setMcpServerSecret('user-1', 'my-project', 'figma', 'FIGMA_TOKEN', 'v', dataRoot)
    expect(hasMcpServerSecret('user-1', 'my-project', 'figma', 'FIGMA_TOKEN', dataRoot)).toBe(true)
  })

  it('scopes secrets by user, project, and server independently', async () => {
    await setMcpServerSecret('user-1', 'proj-a', 'figma', 'TOKEN', 'value-a', dataRoot)
    await setMcpServerSecret('user-2', 'proj-a', 'figma', 'TOKEN', 'value-b', dataRoot)
    await setMcpServerSecret('user-1', 'proj-b', 'figma', 'TOKEN', 'value-c', dataRoot)
    await setMcpServerSecret('user-1', 'proj-a', 'github', 'TOKEN', 'value-d', dataRoot)

    expect(await getMcpServerSecret('user-1', 'proj-a', 'figma', 'TOKEN', dataRoot)).toBe('value-a')
    expect(await getMcpServerSecret('user-2', 'proj-a', 'figma', 'TOKEN', dataRoot)).toBe('value-b')
    expect(await getMcpServerSecret('user-1', 'proj-b', 'figma', 'TOKEN', dataRoot)).toBe('value-c')
    expect(await getMcpServerSecret('user-1', 'proj-a', 'github', 'TOKEN', dataRoot)).toBe('value-d')
  })

  it('deleteMcpServerSecrets removes every field for that server', async () => {
    await setMcpServerSecret('user-1', 'proj-a', 'figma', 'TOKEN_A', 'a', dataRoot)
    await setMcpServerSecret('user-1', 'proj-a', 'figma', 'TOKEN_B', 'b', dataRoot)
    deleteMcpServerSecrets('user-1', 'proj-a', 'figma', dataRoot)
    expect(await getMcpServerSecret('user-1', 'proj-a', 'figma', 'TOKEN_A', dataRoot)).toBeNull()
    expect(await getMcpServerSecret('user-1', 'proj-a', 'figma', 'TOKEN_B', dataRoot)).toBeNull()
  })

  it('deleteMcpServerSecrets never throws when nothing was stored', () => {
    expect(() => deleteMcpServerSecrets('user-1', 'no-such-project', 'no-such-server', dataRoot)).not.toThrow()
  })

  it('rejects unsafe path segments (never lets a caller-controlled id escape the data root)', async () => {
    await expect(setMcpServerSecret('../escape', 'p', 's', 'f', 'v', dataRoot)).rejects.toThrow()
    await expect(setMcpServerSecret('u', '../escape', 's', 'f', 'v', dataRoot)).rejects.toThrow()
    await expect(setMcpServerSecret('u', 'p', '../escape', 'f', 'v', dataRoot)).rejects.toThrow()
  })

  it('rejects a segment that is EXACTLY ".." or "." even though those characters are otherwise allowed (real names may contain a dot)', async () => {
    await expect(setMcpServerSecret('u', '..', 's', 'f', 'v', dataRoot)).rejects.toThrow()
    await expect(setMcpServerSecret('u', '.', 's', 'f', 'v', dataRoot)).rejects.toThrow()
    // A dot as PART of a longer segment is still fine — real project names can contain one.
    await expect(setMcpServerSecret('u', 'my.project', 's', 'f', 'v', dataRoot)).resolves.toBeUndefined()
  })

  it('resolveMcpServerSecretsRoot honours MCP_SERVER_SECRETS_DATA_DIR', () => {
    const root = resolveMcpServerSecretsRoot({ MCP_SERVER_SECRETS_DATA_DIR: '/tmp/custom-root' })
    expect(root).toBe('/tmp/custom-root')
  })

  it('resolveMcpServerSecretsRoot defaults under .data/, matching the git-ignored data root convention', () => {
    const root = resolveMcpServerSecretsRoot({})
    expect(root).toContain('.data')
    expect(root).toContain('mcp-server-secrets')
  })

  it('throws McpServerSecretKeyMismatchError when the stored fingerprint no longer matches the live master key', async () => {
    await setMcpServerSecret('user-1', 'proj-a', 'figma', 'TOKEN', 'v', dataRoot)
    // Hand-corrupt the stored fingerprint to simulate a master-key rotation.
    const path = join(dataRoot, 'user-1', 'proj-a', 'figma.json')
    const file = JSON.parse(readFileSync(path, 'utf8'))
    file.TOKEN.keyFingerprint = 'stale-fingerprint-from-a-rotated-key'
    await Bun.write(path, JSON.stringify(file))

    await expect(getMcpServerSecret('user-1', 'proj-a', 'figma', 'TOKEN', dataRoot)).rejects.toThrow(
      McpServerSecretKeyMismatchError,
    )
  })
})
