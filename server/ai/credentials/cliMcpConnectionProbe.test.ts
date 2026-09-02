/**
 * `cliMcpConnectionProbe` — the only thing that can see a sign-in Studio's own
 * token store structurally cannot.
 *
 * The parser is pinned against VERBATIM `claude mcp list` output captured from
 * a real run, because there is no `--json` for that subcommand and the text is
 * therefore the contract.
 */
import { describe, expect, it, beforeEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearCliMcpConnectionCache,
  clearCliNeedsAuthCache,
  parseCliMcpList,
  probeCliMcpConnections,
  readCachedCliMcpConnections,
  recallCliSignIns,
  rememberCliSignIn,
} from './cliMcpConnectionProbe'

/** Captured verbatim, including the diagnostics block the parser must ignore. */
const REAL_OUTPUT = `Checking MCP server health…

claude.ai Almosafer.com: https://chatgpt.almosafer.com/mcp/claude - ✔ Connected
claude.ai Dovetail: https://dovetail.com/api/mcp - ! Needs authentication
claude.ai Hugging Face: https://huggingface.co/mcp - ✔ Connected
figma: https://mcp.figma.com/mcp (HTTP) - ✔ Connected

MCP config diagnostics ⚠

For help configuring MCP servers, see: https://code.claude.com/docs/en/mcp

[Conflicting scopes]
├ Server "figma" is defined in multiple scopes with different endpoints: user (bunx -y figma-developer-mcp --stdio), local (https://mcp.figma.com/mcp). OAuth tokens are stored per endpoint, so authenticating in one context will not carry over.
└ Keep the correct endpoint and remove the others: \`claude mcp remove figma -s user\`
`

describe('parseCliMcpList', () => {
  it('reads connected and needs-auth out of real output', () => {
    const connections = parseCliMcpList(REAL_OUTPUT)
    expect(connections.get('figma')).toBe('connected')
    expect(connections.get('claude.ai Dovetail')).toBe('needs-auth')
    expect(connections.get('claude.ai Hugging Face')).toBe('connected')
  })

  it('keeps server names that contain spaces and dots intact', () => {
    expect(parseCliMcpList(REAL_OUTPUT).get('claude.ai Almosafer.com')).toBe('connected')
  })

  it('ignores the header, the diagnostics block, and its bullet lines', () => {
    const names = [...parseCliMcpList(REAL_OUTPUT).keys()]
    expect(names).not.toContain('Checking MCP server health…')
    expect(names.some((n) => n.startsWith('├') || n.startsWith('└'))).toBe(false)
    // The diagnostics bullet mentions figma and a URL; it must not overwrite
    // the real status line with a parse of prose.
    expect(names).toHaveLength(4)
  })

  it('returns an empty map for output it does not recognise, never a guess', () => {
    expect(parseCliMcpList('').size).toBe(0)
    expect(parseCliMcpList('some future format\nwith no statuses').size).toBe(0)
  })

  it('omits a server whose status wording it cannot read, rather than calling it disconnected', () => {
    const parsed = parseCliMcpList('figma: https://mcp.figma.com/mcp (HTTP) - ⏸ Pending approval')
    expect(parsed.has('figma')).toBe(false)
  })
})

/** Minimal `SubprocessSpawnFn` stand-in — enough for `captureSubprocess` to read one result. */
function fakeSpawn(stdout: string, exitCode = 0) {
  return () =>
    ({
      stdout: new Response(stdout).body!,
      stderr: new Response('').body!,
      exited: Promise.resolve(exitCode),
      kill() {},
    }) as unknown as ReturnType<import('../../handlers/studio/subprocessRunner').SubprocessSpawnFn>
}

describe('probeCliMcpConnections', () => {
  beforeEach(() => {
    clearCliMcpConnectionCache()
  })

  it('reports what the CLI connected to', async () => {
    const connections = await probeCliMcpConnections({ configDir: '/tmp/cfg-a', spawn: fakeSpawn(REAL_OUTPUT) })
    expect(connections.get('figma')).toBe('connected')
  })

  it('caches, so a second read costs no subprocess', async () => {
    let spawns = 0
    const counting = () => {
      spawns += 1
      return fakeSpawn(REAL_OUTPUT)()
    }
    await probeCliMcpConnections({ configDir: '/tmp/cfg-b', spawn: counting })
    await probeCliMcpConnections({ configDir: '/tmp/cfg-b', spawn: counting })
    expect(spawns).toBe(1)
  })

  it('expires the cache, so signing in is picked up without restarting Studio', async () => {
    const t0 = 1_000_000
    await probeCliMcpConnections({ configDir: '/tmp/cfg-c', spawn: fakeSpawn(REAL_OUTPUT), now: t0 })
    expect(readCachedCliMcpConnections('/tmp/cfg-c', t0 + 30_000)).not.toBeNull()
    expect(readCachedCliMcpConnections('/tmp/cfg-c', t0 + 120_000)).toBeNull()
  })

  it('never spawns from the cache reader — it is on the per-turn prompt path', () => {
    expect(readCachedCliMcpConnections('/tmp/never-probed')).toBeNull()
  })

  it('degrades to an empty map when the CLI is missing, never to "not connected"', async () => {
    const throwing = () => {
      throw new Error('ENOENT: claude not found')
    }
    const connections = await probeCliMcpConnections({ configDir: '/tmp/cfg-d', spawn: throwing as never })
    expect(connections.size).toBe(0)
    // And a failure is not cached — the next call retries rather than
    // reporting "nothing connected" for a minute.
    expect(readCachedCliMcpConnections('/tmp/cfg-d')).toBeNull()
  })

  it('still parses a listing that came with a non-zero exit code', async () => {
    const connections = await probeCliMcpConnections({ configDir: '/tmp/cfg-e', spawn: fakeSpawn(REAL_OUTPUT, 1) })
    expect(connections.get('figma')).toBe('connected')
  })
})

describe('remembered sign-ins', () => {
  it('round-trips, is idempotent, and never records twice', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-signin-'))
    try {
      expect(recallCliSignIns(dir)).toEqual([])
      rememberCliSignIn(dir, 'figma')
      rememberCliSignIn(dir, 'figma')
      expect(recallCliSignIns(dir)).toEqual(['figma'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is one-way — nothing here can revoke a working connector', () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-signin-'))
    try {
      rememberCliSignIn(dir, 'figma')
      // There is deliberately no "forget" export: a failed or offline probe
      // must never read as "signed out" and silently disable Figma.
      expect(Object.keys({ rememberCliSignIn, recallCliSignIns })).not.toContain('forgetCliSignIn')
      expect(recallCliSignIns(dir)).toEqual(['figma'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('degrades to empty for a missing or corrupt file, never throwing on the turn path', () => {
    expect(recallCliSignIns('/tmp/studio-signin-does-not-exist')).toEqual([])
    const dir = mkdtempSync(join(tmpdir(), 'studio-signin-'))
    try {
      writeFileSync(join(dir, 'studio-mcp-signin.json'), 'not json at all')
      expect(recallCliSignIns(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * The CLI's own needs-auth cache — the half that made a completed sign-in buy
 * nothing, because a headless turn reads this file instead of the server.
 */
describe('clearCliNeedsAuthCache', () => {
  const CACHE_FILE = 'mcp-needs-auth-cache.json'

  function withDir(run: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), 'studio-needs-auth-'))
    try {
      run(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('drops only the named servers and leaves the rest of the file intact', () => {
    withDir((dir) => {
      writeFileSync(
        join(dir, CACHE_FILE),
        JSON.stringify({
          figma: { timestamp: 1788348166080 },
          'claude.ai Dovetail': { timestamp: 1788348439725, id: 'mcpsrv_01Djv' },
        }),
      )

      clearCliNeedsAuthCache(dir, ['figma'])

      expect(JSON.parse(readFileSync(join(dir, CACHE_FILE), 'utf8'))).toEqual({
        'claude.ai Dovetail': { timestamp: 1788348439725, id: 'mcpsrv_01Djv' },
      })
    })
  })

  it('leaves a server it was not told about alone — an unauthenticated server keeps its honest verdict', () => {
    withDir((dir) => {
      const original = JSON.stringify({ 'claude.ai Dovetail': { timestamp: 1 } })
      writeFileSync(join(dir, CACHE_FILE), original)

      clearCliNeedsAuthCache(dir, ['figma'])

      expect(readFileSync(join(dir, CACHE_FILE), 'utf8')).toBe(original)
    })
  })

  it('never throws on the turn path — missing, corrupt, and non-object files all mean "leave it alone"', () => {
    expect(() => clearCliNeedsAuthCache('/tmp/studio-needs-auth-does-not-exist', ['figma'])).not.toThrow()
    withDir((dir) => {
      writeFileSync(join(dir, CACHE_FILE), 'not json at all')
      expect(() => clearCliNeedsAuthCache(dir, ['figma'])).not.toThrow()
      expect(readFileSync(join(dir, CACHE_FILE), 'utf8')).toBe('not json at all')

      writeFileSync(join(dir, CACHE_FILE), '["figma"]')
      expect(() => clearCliNeedsAuthCache(dir, ['figma'])).not.toThrow()
      expect(readFileSync(join(dir, CACHE_FILE), 'utf8')).toBe('["figma"]')
    })
  })

  it('does nothing at all when there is nothing to prune', () => {
    withDir((dir) => {
      clearCliNeedsAuthCache(dir, [])
      expect(existsSync(join(dir, CACHE_FILE))).toBe(false)
    })
  })
})
