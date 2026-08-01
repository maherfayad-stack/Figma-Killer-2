/**
 * claudeCli.ts — the AiProvider `stream()` implementation end-to-end, with
 * an injected fake spawn (never the real `claude` binary, never a real
 * subprocess) and injected fake MCP connector mint/revoke (never a real
 * database). Fixtures use the exact CLI event shapes WS-11 §4.0 verified.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AiMessage } from '../runtime/types'
import type { AiResolvedCredential, AiStreamRequest } from './types'
import type { SpawnedProcessLike, SubprocessSpawnFn } from '../../handlers/studio/subprocessRunner'
import { claudeCliDriver, streamClaudeCli } from './claudeCli'
import { claudeCliSessionId } from './claudeCliSession'
import type { ClaudeCliSessionConnector } from '../mcp/sessionConnector'

let dataRoot: string
let projectsRoot: string
let projectDir: string
beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'claude-cli-driver-test-'))
  projectsRoot = mkdtempSync(join(tmpdir(), 'claude-cli-driver-projects-'))
  projectDir = join(projectsRoot, 'my-project')
  mkdirSync(projectDir, { recursive: true })
})
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true })
  rmSync(projectsRoot, { recursive: true, force: true })
})

function streamFromString(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

interface FakeCliOptions {
  stdoutLines: object[]
  stderr?: string
  exitCode?: number
  onSpawn?: (argv: string[], env: Record<string, string>, cwd: string) => void
}

function fakeCliSpawn(opts: FakeCliOptions): SubprocessSpawnFn {
  return (argv, options) => {
    opts.onSpawn?.(argv, options.env, options.cwd)
    const stdout = opts.stdoutLines.map((line) => JSON.stringify(line)).join('\n') + '\n'
    const proc: SpawnedProcessLike = {
      stdout: streamFromString(stdout),
      stderr: streamFromString(opts.stderr ?? ''),
      exited: Promise.resolve(opts.exitCode ?? 0),
      kill: () => {},
    }
    return proc
  }
}

function userMessage(text: string): AiMessage {
  return { role: 'user', content: [{ kind: 'text', text }] }
}

function credentials(apiKey: string | null): AiResolvedCredential {
  return { id: 'cred-1', providerId: 'claudeCli', authMode: 'apiKey', apiKey, baseUrl: null }
}

/** A working fake connector mint — most tests want tools to succeed. */
async function fakeMintConnector(): Promise<ClaudeCliSessionConnector> {
  return { connectorId: 'connector-1', token: 'fake-session-token' }
}
let revokedCalls: Array<{ connectorId: string; userId: string }> = []
async function fakeRevokeConnector(_db: unknown, connectorId: string, userId: string): Promise<void> {
  revokedCalls.push({ connectorId, userId })
}

/**
 * WS-12 §7 — inert no-op default so every existing test stays about
 * argv/spawn, not disk I/O. Deliberately holds NO module-level mutable
 * state (unlike `revokedCalls` above) — the dedicated roster-call tests
 * capture into a LOCAL array declared inside their own `it()`, the same
 * pattern `capturedArgv`/`capturedCwd` already use elsewhere in this file.
 * A shared module-level array reset only in `beforeEach` was the earlier
 * shape and is exactly what caused the cross-file test-ordering pollution
 * (`streamClaudeCli — subagent roster generation` passing 23/23 in
 * isolation but failing in the full suite) — Bun runs every test file in
 * one shared process without resetting module state between files, so a
 * `let` at this scope is never truly private to this file's own run.
 */
function fakeGenerateRoster() {
  return { written: [], skipped: [] }
}

function baseRequest(overrides: Partial<AiStreamRequest> = {}): AiStreamRequest {
  return {
    systemPrompt: ['You are a test.'],
    messages: [userMessage('Hello, Claude.')],
    tools: [],
    modelId: 'sonnet',
    modelCapabilities: { toolCalling: true, visionInput: false, toolResultImages: false, promptCache: false, streaming: true },
    credentials: credentials('token-abc'),
    signal: new AbortController().signal,
    bridge: { async callBrowser() { return { ok: false, error: 'unused' } } },
    toolContextBase: {
      db: {} as never,
      userId: 'user-1',
      capabilities: ['ai.chat'],
      conversationId: 'conv-1',
      snapshot: null,
    },
    ...overrides,
  }
}

async function collect(req: AiStreamRequest, opts: Parameters<typeof streamClaudeCli>[1]) {
  const out = []
  for await (const event of streamClaudeCli(req, opts)) out.push(event)
  return out
}

/** Default test options: fake spawn/connectors always injected, real DB/binary never touched. */
function testOptions(overrides: Partial<Parameters<typeof streamClaudeCli>[1]> = {}) {
  return {
    dataRoot,
    projectsRoot,
    serverPort: 3001,
    mintConnector: fakeMintConnector,
    revokeConnector: fakeRevokeConnector,
    generateRoster: fakeGenerateRoster,
    ...overrides,
  }
}

beforeEach(() => {
  revokedCalls = []
})

describe('streamClaudeCli — happy path', () => {
  it('streams text, then usage/context/done from the terminal result event', async () => {
    let capturedArgv: string[] = []
    let capturedEnv: Record<string, string> = {}
    let capturedCwd = ''
    const spawn = fakeCliSpawn({
      stdoutLines: [
        { type: 'system', subtype: 'init', cwd: '/x', session_id: 's1', model: 'claude-sonnet-4-6' },
        { type: 'assistant', message: { model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'Hi there.' }] } },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'Hi there.',
          usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          total_cost_usd: 0.002,
        },
      ],
      onSpawn: (argv, env, cwd) => {
        capturedArgv = argv
        capturedEnv = env
        capturedCwd = cwd
      },
    })

    const expectedSessionId = await claudeCliSessionId('conv-1')
    const events = await collect(
      baseRequest({ workspaceDir: projectDir }),
      testOptions({ spawn }),
    )

    expect(events).toEqual([
      { type: 'text', text: 'Hi there.' },
      { type: 'context', promptTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
      { type: 'usage', promptTokens: 50, completionTokens: 10, costUsd: 0.002, cacheReadTokens: 0, cacheCreationTokens: 0 },
      { type: 'done' },
    ])

    // Spawn shape — WS-11 §4.0 widened per steps 2+3 (effort, mcp-config,
    // strict-mcp-config, session continuity).
    expect(capturedArgv).toEqual([
      'claude', '-p', 'Hello, Claude.',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', 'sonnet',
      '--effort', 'medium',
      '--permission-mode', 'default',
      '--mcp-config', JSON.stringify({
        mcpServers: {
          studio: {
            type: 'http',
            url: 'http://127.0.0.1:3001/_studio/mcp',
            headers: { Authorization: 'Bearer fake-session-token' },
          },
        },
      }),
      '--strict-mcp-config',
      // First turn (exactly one message) → establish, not resume.
      '--session-id', expectedSessionId,
    ])
    expect(capturedEnv.CLAUDE_CONFIG_DIR).toBe(join(dataRoot, 'user-1'))
    expect(capturedEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-abc')
    // A real chat turn spawns in the resolved WORKSPACE, not the config dir.
    expect(capturedCwd).toBe(projectDir)

    // The session connector is revoked the instant the turn ends.
    expect(revokedCalls).toEqual([{ connectorId: 'connector-1', userId: 'user-1' }])
  })

  it('omits CLAUDE_CODE_OAUTH_TOKEN when the credential carries no apiKey (the L1 shape)', async () => {
    let capturedEnv: Record<string, string> = {}
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (_argv, env) => { capturedEnv = env },
    })
    await collect(baseRequest({ credentials: credentials(null) }), testOptions({ spawn }))
    expect(capturedEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(capturedEnv.CLAUDE_CONFIG_DIR).toBeTruthy()
  })
})

describe('streamClaudeCli — workspace cwd (WS-11 step 2 fix)', () => {
  it('falls back to the per-user config dir when no workspaceDir is supplied', async () => {
    let capturedCwd = ''
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (_argv, _env, cwd) => { capturedCwd = cwd },
    })
    await collect(baseRequest(), testOptions({ spawn }))
    expect(capturedCwd).toBe(join(dataRoot, 'user-1'))
  })

  it('falls back to the config dir when workspaceDir fails containment (never trusts the client)', async () => {
    let capturedCwd = ''
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (_argv, _env, cwd) => { capturedCwd = cwd },
    })
    const escapeDir = mkdtempSync(join(tmpdir(), 'claude-cli-escape-'))
    try {
      await collect(baseRequest({ workspaceDir: escapeDir }), testOptions({ spawn }))
      expect(capturedCwd).toBe(join(dataRoot, 'user-1'))
    } finally {
      rmSync(escapeDir, { recursive: true, force: true })
    }
  })

  it('uses the resolved workspace root when it is a genuine, contained project', async () => {
    let capturedCwd = ''
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (_argv, _env, cwd) => { capturedCwd = cwd },
    })
    await collect(baseRequest({ workspaceDir: projectDir }), testOptions({ spawn }))
    expect(capturedCwd).toBe(projectDir)
  })
})

describe('streamClaudeCli — subagent roster generation (WS-12 §7)', () => {
  it('generates the roster into the resolved workspace root when a real project is open', async () => {
    // Captured locally, not via shared module state — see `fakeGenerateRoster`'s
    // own doc comment for why a module-level array here previously caused
    // test-ordering pollution across the full suite.
    const calls: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
    })
    await collect(
      baseRequest({ workspaceDir: projectDir }),
      testOptions({ spawn, generateRoster: (dir: string) => { calls.push(dir); return { written: [], skipped: [] } } }),
    )
    expect(calls).toEqual([projectDir])
  })

  it('never generates a roster into the per-user config dir (no workspace open)', async () => {
    const calls: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
    })
    await collect(
      baseRequest(),
      testOptions({ spawn, generateRoster: (dir: string) => { calls.push(dir); return { written: [], skipped: [] } } }),
    )
    expect(calls).toEqual([])
  })

  it('a roster-generation failure degrades the turn, never aborts it', async () => {
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
    })
    const throwingRoster = () => {
      throw new Error('boom')
    }
    const events = await collect(
      baseRequest({ workspaceDir: projectDir }),
      testOptions({ spawn, generateRoster: throwingRoster as never }),
    )
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events.some((e) => e.type === 'done')).toBe(true)
  })
})

describe('streamClaudeCli — session continuity (WS-11 step 2)', () => {
  it('uses --session-id on the first turn (exactly one message)', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })
    await collect(baseRequest({ messages: [userMessage('first')] }), testOptions({ spawn }))
    expect(capturedArgv.at(-2)).toBe('--session-id')
  })

  it('uses --resume once history has accumulated', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })
    await collect(baseRequest({
      messages: [userMessage('first'), userMessage('second')],
    }), testOptions({ spawn }))
    expect(capturedArgv.at(-2)).toBe('--resume')
  })

  it('derives the SAME session id for the same conversation on every turn', async () => {
    const first = await claudeCliSessionId('conv-1')
    const second = await claudeCliSessionId('conv-1')
    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('derives a DIFFERENT session id for a different conversation', async () => {
    const a = await claudeCliSessionId('conv-a')
    const b = await claudeCliSessionId('conv-b')
    expect(a).not.toBe(b)
  })
})

describe('streamClaudeCli — session controls (WS-12 §5)', () => {
  it('defaults to --effort medium and --permission-mode default when the request names neither', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })
    await collect(baseRequest(), testOptions({ spawn }))
    expect(capturedArgv[capturedArgv.indexOf('--effort') + 1]).toBe('medium')
    expect(capturedArgv[capturedArgv.indexOf('--permission-mode') + 1]).toBe('default')
  })

  it('passes the request\'s own effort straight through', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })
    await collect(baseRequest({ effort: 'xhigh' }), testOptions({ spawn }))
    expect(capturedArgv[capturedArgv.indexOf('--effort') + 1]).toBe('xhigh')
  })

  it('passes acceptEdits and plan straight through — the two non-default modes this driver actually allows', async () => {
    for (const mode of ['acceptEdits', 'plan'] as const) {
      let capturedArgv: string[] = []
      const spawn = fakeCliSpawn({
        stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
        onSpawn: (argv) => { capturedArgv = argv },
      })
      await collect(baseRequest({ permissionMode: mode }), testOptions({ spawn }))
      expect(capturedArgv[capturedArgv.indexOf('--permission-mode') + 1]).toBe(mode)
    }
  })

  it('REFUSES bypassPermissions — never spawns, never constructs --permission-mode bypassPermissions', async () => {
    let spawnCalled = false
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: () => { spawnCalled = true },
    })
    const events = await collect(baseRequest({ permissionMode: 'bypassPermissions' }), testOptions({ spawn }))
    expect(spawnCalled).toBe(false)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error' })
    expect((events[0] as { message: string }).message).toContain('Bypass mode is not available')
  })

  it('rejects an unrecognised permission mode the same way — refuses, never spawns', async () => {
    let spawnCalled = false
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: () => { spawnCalled = true },
    })
    const events = await collect(
      baseRequest({ permissionMode: 'somethingElse' as never }),
      testOptions({ spawn }),
    )
    expect(spawnCalled).toBe(false)
    expect(events[0]).toMatchObject({ type: 'error' })
  })
})

describe('streamClaudeCli — MCP tool routing (WS-11 step 3)', () => {
  it('mints a connector with the caller\'s own capabilities and revokes it when the turn ends', async () => {
    const mintCalls: Array<{ userId: string; capabilities: readonly string[]; conversationId: string }> = []
    const mint = async (
      _db: unknown,
      userId: string,
      capabilities: readonly string[],
      conversationId: string,
    ): Promise<ClaudeCliSessionConnector> => {
      mintCalls.push({ userId, capabilities, conversationId })
      return { connectorId: 'connector-xyz', token: 'tok-xyz' }
    }
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
    })
    await collect(
      baseRequest({ toolContextBase: { db: {} as never, userId: 'user-9', capabilities: ['ai.chat', 'site.read'], conversationId: 'conv-9', snapshot: null } }),
      testOptions({ spawn, mintConnector: mint as never }),
    )
    expect(mintCalls).toEqual([{ userId: 'user-9', capabilities: ['ai.chat', 'site.read'], conversationId: 'conv-9' }])
    expect(revokedCalls).toEqual([{ connectorId: 'connector-xyz', userId: 'user-9' }])
  })

  it('degrades to a tool-less turn (no --mcp-config) when minting fails, rather than failing the whole turn', async () => {
    let capturedArgv: string[] = []
    const failingMint = async (): Promise<ClaudeCliSessionConnector> => {
      throw new Error('connector store unavailable')
    }
    const spawn = fakeCliSpawn({
      stdoutLines: [
        { type: 'assistant', message: { model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'still works' }] } },
        { type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } },
      ],
      onSpawn: (argv) => { capturedArgv = argv },
    })
    const originalError = console.error
    console.error = () => {}
    try {
      const events = await collect(baseRequest(), testOptions({ spawn, mintConnector: failingMint as never }))
      expect(events.some((e) => e.type === 'text')).toBe(true)
      expect(capturedArgv).not.toContain('--mcp-config')
      // --strict-mcp-config is unconditional either way (WS-11 §4.0 trap #4).
      expect(capturedArgv).toContain('--strict-mcp-config')
      // Nothing to revoke — minting never produced a connector.
      expect(revokedCalls).toEqual([])
    } finally {
      console.error = originalError
    }
  })

  it('always passes --strict-mcp-config, even with a connector minted', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })
    await collect(baseRequest(), testOptions({ spawn }))
    expect(capturedArgv).toContain('--strict-mcp-config')
  })
})

describe('streamClaudeCli — auth failure (WS-11 §4.0)', () => {
  it('emits no text for the synthetic assistant message, then a terminal error from result.is_error', async () => {
    const spawn = fakeCliSpawn({
      stdoutLines: [
        { type: 'system', subtype: 'init' },
        { type: 'assistant', error: 'authentication_failed', message: { model: '<synthetic>', content: [] } },
        { type: 'result', subtype: 'success', is_error: true, result: 'authentication_failed', usage: { input_tokens: 0, output_tokens: 0 } },
      ],
    })
    const events = await collect(baseRequest(), testOptions({ spawn }))
    expect(events.some((e) => e.type === 'text')).toBe(false)
    const errorEvent = events.find((e) => e.type === 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as { message: string }).message).toContain('authentication_failed')
    // done must never fire alongside an error.
    expect(events.some((e) => e.type === 'done')).toBe(false)
  })
})

describe('streamClaudeCli — process exit with no result event', () => {
  it('synthesizes an error from stderr when the process crashes before emitting a result', async () => {
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'system', subtype: 'init' }],
      stderr: 'Segmentation fault (core dumped)',
      exitCode: 139,
    })
    const events = await collect(baseRequest(), testOptions({ spawn }))
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('error')
    expect((events[0] as { message: string }).message).toContain('Segmentation fault')
  })
})

describe('streamClaudeCli — platform support', () => {
  it('errors immediately on an unsupported platform, without spawning', async () => {
    let spawnCalled = false
    const spawn: SubprocessSpawnFn = () => {
      spawnCalled = true
      throw new Error('must not be called')
    }
    const events = await collect(baseRequest(), testOptions({
      spawn,
      platformSupport: { supported: false, reason: 'macOS cannot isolate Claude CLI logins per user.' },
    }))
    expect(spawnCalled).toBe(false)
    expect(events).toEqual([{ type: 'error', message: 'macOS cannot isolate Claude CLI logins per user.' }])
  })
})

describe('streamClaudeCli — defensive credential-shape guard', () => {
  it('refuses a baseUrl-mode credential', async () => {
    const events = await collect(
      baseRequest({ credentials: { id: 'c', providerId: 'claudeCli', authMode: 'baseUrl', apiKey: null, baseUrl: 'http://x' } }),
      testOptions(),
    )
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('error')
  })
})

describe('streamClaudeCli — prompt assembly', () => {
  it('errors when there is no user message to send', async () => {
    const events = await collect(baseRequest({ messages: [] }), testOptions())
    expect(events).toEqual([{ type: 'error', message: 'No user message to send to the Claude CLI.' }])
  })

  it('uses the LATEST user message when history has several', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })
    await collect(baseRequest({
      messages: [userMessage('first'), userMessage('second'), userMessage('third')],
    }), testOptions({ spawn }))
    expect(capturedArgv[2]).toBe('third')
  })
})

describe('claudeCliDriver — AiProvider shape', () => {
  it('reports capabilities and a static fallback model list', () => {
    expect(claudeCliDriver.id).toBe('claudeCli')
    expect(claudeCliDriver.supportedAuthModes).toEqual(['apiKey'])
    expect(claudeCliDriver.capabilities('sonnet').toolCalling).toBe(true)
  })

  it('listModels returns the static catalogue, all marked fallback', async () => {
    const models = await claudeCliDriver.listModels(credentials('x'))
    expect(models.length).toBeGreaterThan(0)
    expect(models.every((m) => m.catalogueSource === 'fallback')).toBe(true)
  })
})
