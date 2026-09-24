/**
 * Review of #251, F2: the ONE agent write gate refuses credential files, so
 * the `claude` CLI's native Write/Edit (via the PreToolUse hook) and the HTTP
 * file tools answer the same — and a checkpoint never ends up holding a copy.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentWriteRefusal } from './agentWriteScope'
import { resolveAgentFilePath } from './agentFileAccess'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'studio-write-scope-creds-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const CREDENTIALS = ['credentials.json', 'certs/server.key', 'id_rsa', 'config/secrets.json', '.pgpass', 'infra/prod.tfvars', '.dev.vars', 'keys/app.pem']

describe('agentWriteRefusal — credential files', () => {
  for (const rel of CREDENTIALS) {
    it(`refuses ${rel} on the gate both paths share`, () => {
      expect(agentWriteRefusal(join(dir, ...rel.split('/')), dir)?.code).toBe('protected-path')
      const http = resolveAgentFilePath(dir, rel, 'write')
      expect(http.ok).toBe(false)
    })
  }

  it('an env file stays needs-user (the user makes that change), and ordinary source is still writable', () => {
    expect(agentWriteRefusal(join(dir, '.env'), dir)?.code).toBe('needs-user')
    expect(agentWriteRefusal(join(dir, 'pages', 'Home.tsx'), dir)).toBeNull()
    expect(agentWriteRefusal(join(dir, 'src', 'keyboard.ts'), dir)).toBeNull()
  })
})
