/**
 * claudeCli.ts — the AiProvider `stream()` implementation end-to-end, with
 * an injected fake spawn (never the real `claude` binary, never a real
 * subprocess) and injected fake MCP connector mint/revoke (never a real
 * database). Fixtures use the exact CLI event shapes WS-11 §4.0 verified.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AiMessage } from '../runtime/types'
import type { AiResolvedCredential, AiStreamRequest } from './types'
import type { SpawnedProcessLike, SubprocessSpawnFn } from '../../handlers/studio/subprocessRunner'
import { claudeCliDriver, streamClaudeCli } from './claudeCli'
import { verifyClaudeCliCredential } from './claudeCliVerify'
import {
  addRegisteredMcpServer,
  approveRegisteredMcpServer,
  registeredMcpServerProjectKey,
} from './registeredMcpServers'
import { setMcpServerSecret } from '../credentials/mcpServerSecretStore'
import { claudeCliProjectDirName, claudeCliSessionId } from './claudeCliSession'
import type { ClaudeCliSessionConnector } from '../mcp/sessionConnector'
import { getPermissionGate } from '../mcp/permissionGate'

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
  onSpawn?: (argv: string[], env: Record<string, string>, cwd: string, stdin: string) => void
}

function fakeCliSpawn(opts: FakeCliOptions): SubprocessSpawnFn {
  return (argv, options) => {
    // The prompt is piped, never an argv positional — decode it so tests can
    // assert on it the same way they used to assert on argv[2].
    const stdin = options.stdin === 'ignore' ? '' : new TextDecoder().decode(options.stdin)
    opts.onSpawn?.(argv, options.env, options.cwd, stdin)
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

const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function userMessageWithImage(text: string): AiMessage {
  return {
    role: 'user',
    content: [
      { kind: 'text', text },
      { kind: 'image', mimeType: 'image/png', data: ONE_PIXEL_PNG_BASE64 },
    ],
  }
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
function fakeGenerateGuide() {
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
    generateGuide: fakeGenerateGuide,
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
    // Read the config file's content INSIDE onSpawn, not after `collect()`
    // resolves — the driver's own `finally` deletes it the instant the turn
    // ends, so reading it afterward would always see it already gone (see
    // the "MCP config file" describe block's own cleanup tests below).
    let mcpConfigFileContent: unknown
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
        const path = argv[argv.indexOf('--mcp-config') + 1]!
        mcpConfigFileContent = JSON.parse(readFileSync(path, 'utf8'))
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
    // strict-mcp-config, session continuity). `--mcp-config`'s value is now a
    // PATH to a private temp file, never inline JSON — see the "MCP config
    // file" describe block below for the file-content and permission
    // assertions this shape change requires.
    const mcpConfigIndex = capturedArgv.indexOf('--mcp-config')
    const mcpConfigPath = capturedArgv[mcpConfigIndex + 1]!
    const argvWithoutMcpConfigValue = [...capturedArgv]
    argvWithoutMcpConfigValue[mcpConfigIndex + 1] = '<mcp-config-path>'
    expect(argvWithoutMcpConfigValue).toEqual([
      'claude', '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model', 'sonnet',
      '--effort', 'medium',
      '--permission-mode', 'acceptEdits',
      // A real project is open, no attachment on this turn: the file tools
      // (subagent dispatch) only, never Read/Bash/Write/Edit.
      '--tools', 'Read,Write,Edit,Glob,Grep',
      '--mcp-config', '<mcp-config-path>',
      // Headless, the CLI has no TTY to prompt in; this routes a permission
      // request to the open chat instead of it being silently refused.
      '--permission-prompt-tool', 'mcp__studio__permission_request',
      '--strict-mcp-config',
      // First turn (exactly one message) → establish, not resume.
      '--session-id', expectedSessionId,
    ])
    // Never inline JSON on the command line — a temp file path instead. The
    // whole reason for this test: `ps -eo command` prints argv verbatim, so
    // an inline `--mcp-config {"headers":{"Authorization":"Bearer …"}}`
    // would leak the connector token to any local process.
    expect(mcpConfigPath).not.toContain('Bearer')
    expect(mcpConfigPath).not.toContain('fake-session-token')
    // A default project gets TWO entries: Studio's own, and the loopback
    // `figma` built-in Studio now ships everywhere (`BUILT_IN_MCP_SERVERS`).
    // Asserted here rather than opted out of, because "what a plain turn
    // actually sends" is exactly what this happy-path test is for — and the
    // built-in carrying no headers is the property that lets it be a default
    // at all.
    expect(mcpConfigFileContent).toEqual({
      mcpServers: {
        studio: {
          type: 'http',
          url: 'http://127.0.0.1:3001/_studio/mcp',
          headers: { Authorization: 'Bearer fake-session-token' },
        },
        figma: {
          type: 'http',
          url: 'http://127.0.0.1:3845/mcp',
        },
      },
    })
    // The file is gone by the time the turn has fully ended.
    expect(existsSync(mcpConfigPath)).toBe(false)
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

describe('streamClaudeCli — project guide generation', () => {
  it('generates the project guide into the resolved workspace root when a real project is open', async () => {
    // Captured locally, not via shared module state — see `fakeGenerateGuide`'s
    // own doc comment for why a module-level array here previously caused
    // test-ordering pollution across the full suite.
    const calls: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
    })
    await collect(
      baseRequest({ workspaceDir: projectDir }),
      testOptions({ spawn, generateGuide: (dir: string) => { calls.push(dir); return { written: [], skipped: [] } } }),
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
      testOptions({ spawn, generateGuide: (dir: string) => { calls.push(dir); return { written: [], skipped: [] } } }),
    )
    expect(calls).toEqual([])
  })

  it('a roster-generation failure degrades the turn, never aborts it', async () => {
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
    })
    const throwingGuide = () => {
      throw new Error('boom')
    }
    const events = await collect(
      baseRequest({ workspaceDir: projectDir }),
      testOptions({ spawn, generateGuide: throwingGuide as never }),
    )
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events.some((e) => e.type === 'done')).toBe(true)
  })
})

describe('streamClaudeCli — dynamic system-prompt suffix + turn write log (the write-verification gate)', () => {
  it('forwards ONLY the dynamic suffix via --append-system-prompt, never the static prefix', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })
    await collect(
      baseRequest({
        workspaceDir: projectDir,
        systemPrompt: ['STATIC PREFIX TEXT', '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__', 'DYNAMIC SUFFIX TEXT'],
      }),
      testOptions({ spawn }),
    )
    const flagIndex = capturedArgv.indexOf('--append-system-prompt')
    expect(flagIndex).toBeGreaterThan(-1)
    expect(capturedArgv[flagIndex + 1]).toBe('DYNAMIC SUFFIX TEXT')
    expect(capturedArgv).not.toContain('STATIC PREFIX TEXT')
  })

  it('omits --append-system-prompt entirely when systemPrompt has no boundary marker', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })
    await collect(baseRequest({ workspaceDir: projectDir }), testOptions({ spawn }))
    expect(capturedArgv).not.toContain('--append-system-prompt')
  })

  it('omits --append-system-prompt when no workspace is open, even with a boundary marker present', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })
    await collect(
      baseRequest({ systemPrompt: ['prefix', '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__', 'suffix'] }),
      testOptions({ spawn }),
    )
    expect(capturedArgv).not.toContain('--append-system-prompt')
  })

  it('resets the turn write log before spawning, so a stale entry from a previous turn never leaks into this one\'s Stop-hook gate', async () => {
    const { mkdirSync, writeFileSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const logPath = join(projectDir, '.studio', 'cache', 'turnWrites.json')
    mkdirSync(join(projectDir, '.studio', 'cache'), { recursive: true })
    writeFileSync(logPath, JSON.stringify([{ file: 'pages/Stale.tsx', atMs: 1 }]))

    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
    })
    await collect(baseRequest({ workspaceDir: projectDir }), testOptions({ spawn }))
    expect(JSON.parse(readFileSync(logPath, 'utf8'))).toEqual([])
  })

  it('never touches the turn write log when no workspace is open', async () => {
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
    })
    await collect(baseRequest(), testOptions({ spawn }))
    // The config-dir fallback (`dataRoot/<userId>`) has no `.studio/` at all —
    // a `resetTurnWriteLog` call there would `mkdirSync` one, which is what
    // this asserts against.
    expect(existsSync(join(dataRoot, 'user-1', '.studio'))).toBe(false)
  })
})

describe('streamClaudeCli — session continuity (WS-11 step 2, extended for session_epoch)', () => {
  /**
   * Writes an empty transcript at the exact path `shouldEstablishClaudeCliSession`
   * probes, so a test can simulate "the CLI already has a session for this
   * uuid at this cwd" without a real subprocess ever running.
   */
  function writeFakeTranscript(configDir: string, cwd: string, sessionId: string): void {
    const dir = join(configDir, 'projects', claudeCliProjectDirName(cwd))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${sessionId}.jsonl`), '')
  }

  it('uses --session-id when the CLI has no transcript for the derived uuid yet — even with a long history', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })
    // Message count is no longer what decides this — a long history with no
    // matching CLI transcript still establishes.
    await collect(baseRequest({
      workspaceDir: projectDir,
      messages: [userMessage('first'), userMessage('second'), userMessage('third')],
    }), testOptions({ spawn }))
    expect(capturedArgv.at(-2)).toBe('--session-id')
  })

  it('uses --resume once the CLI has already written a transcript for this uuid at this cwd', async () => {
    const sessionId = await claudeCliSessionId('conv-1')
    writeFakeTranscript(join(dataRoot, 'user-1'), projectDir,sessionId)

    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })
    // Even a single-message request now resumes, because the real signal
    // (the CLI's own transcript) says a session already exists.
    await collect(baseRequest({ workspaceDir: projectDir, messages: [userMessage('first')] }), testOptions({ spawn }))
    expect(capturedArgv.at(-2)).toBe('--resume')
  })

  it('"Restart agent session" (a bumped session_epoch) re-establishes even with a prior transcript and a long history', async () => {
    // Simulate turns already having happened at epoch 0: a transcript exists
    // for epoch 0's uuid.
    const epoch0SessionId = await claudeCliSessionId('conv-1', 0)
    writeFakeTranscript(join(dataRoot, 'user-1'), projectDir,epoch0SessionId)

    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })
    const epoch1SessionId = await claudeCliSessionId('conv-1', 1)
    await collect(baseRequest({
      workspaceDir: projectDir,
      messages: [userMessage('first'), userMessage('second'), userMessage('third')],
      sessionEpoch: 1,
    }), testOptions({ spawn }))

    // Establishes (not resumes) because epoch 1's derived uuid has no
    // transcript yet — self-healing behaviour a message-count check could
    // never provide.
    expect(capturedArgv.at(-2)).toBe('--session-id')
    expect(capturedArgv.at(-1)).toBe(epoch1SessionId)
    expect(epoch1SessionId).not.toBe(epoch0SessionId)
  })

  it('derives the SAME session id for the same (conversation, epoch) on every turn', async () => {
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
  it('defaults to --effort medium and, with a project open, --permission-mode acceptEdits when the request names neither', async () => {
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

  it('rejects an unrecognised permission mode — refuses, never spawns', async () => {
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

  // ── Bypass mode (WS-12 §5.2, D5 §11.5) — resolved: a user-selected mode ──
  // ── IS the consent; only a Studio-injected default/inference is forbidden.
  describe('bypassPermissions', () => {
    it('IS forwarded when the request explicitly names it — a deliberate user choice, not a Studio default', async () => {
      let capturedArgv: string[] = []
      const spawn = fakeCliSpawn({
        stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
        onSpawn: (argv) => { capturedArgv = argv },
      })
      const events = await collect(baseRequest({ permissionMode: 'bypassPermissions' }), testOptions({ spawn }))
      expect(capturedArgv[capturedArgv.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
      expect(events.some((e) => e.type === 'error')).toBe(false)
    })

    it('never appears in argv when the request is empty — the default resolves to "default", never inferred as bypass', async () => {
      let capturedArgv: string[] = []
      const spawn = fakeCliSpawn({
        stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
        onSpawn: (argv) => { capturedArgv = argv },
      })
      await collect(baseRequest(), testOptions({ spawn }))
      expect(capturedArgv[capturedArgv.indexOf('--permission-mode') + 1]).toBe('default')
      expect(capturedArgv).not.toContain('bypassPermissions')
    })

    it('--dangerously-skip-permissions is never constructed by this driver, under any request shape — a different, still-forbidden flag', async () => {
      let capturedArgv: string[] = []
      const spawn = fakeCliSpawn({
        stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
        onSpawn: (argv) => { capturedArgv = argv },
      })
      await collect(baseRequest({ permissionMode: 'bypassPermissions' }), testOptions({ spawn }))
      expect(capturedArgv).not.toContain('--dangerously-skip-permissions')
      expect(capturedArgv).not.toContain('--allow-dangerously-skip-permissions')
    })
  })
})

// The `--tools` allowlist is a hard availability ceiling on the CLI's own
// native built-ins, present on EVERY real turn (see `claudeCliToolSurface.ts`).
// With a real project open the agent authors files directly, so it holds
// Read/Write/Edit/Glob/Grep — bounded by the subprocess cwd, which is the
// containment-checked project directory. `Bash` and `Task` are never granted
// on any turn, at any trust tier, in any permission mode.
describe('streamClaudeCli — native tool surface', () => {
  const WORKSPACE_TOOLS = 'Read,Write,Edit,Glob,Grep'

  function imageMessage(mimeType: string, data = 'ZmFrZQ=='): AiMessage {
    return { role: 'user', content: [{ kind: 'text', text: 'look at this' }, { kind: 'image', mimeType, data }] }
  }

  it('grants the file tools when a real project is open', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })
    await collect(baseRequest({ workspaceDir: projectDir }), testOptions({ spawn }))
    expect(capturedArgv[capturedArgv.indexOf('--tools') + 1]).toBe(WORKSPACE_TOOLS)
  })

  it('grants NOTHING (empty --tools) when no real project is open and this turn has no attachment — there is no directory to scope a write to', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })
    await collect(baseRequest(), testOptions({ spawn }))
    expect(capturedArgv[capturedArgv.indexOf('--tools') + 1]).toBe('')
  })

  it('falls back to empty --tools when workspaceDir fails containment — never trusts the client into a wider tool surface either', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })
    const escapeDir = mkdtempSync(join(tmpdir(), 'claude-cli-tools-escape-'))
    try {
      await collect(baseRequest({ workspaceDir: escapeDir }), testOptions({ spawn }))
      expect(capturedArgv[capturedArgv.indexOf('--tools') + 1]).toBe('')
    } finally {
      rmSync(escapeDir, { recursive: true, force: true })
    }
  })

  it('adds Read when this turn staged an image attachment, even with no workspace open', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })
    await collect(baseRequest({ messages: [imageMessage('image/png')] }), testOptions({ spawn }))
    expect(capturedArgv[capturedArgv.indexOf('--tools') + 1]).toBe('Read')
  })

  it('does not double up Read when a project is open AND this turn staged an attachment', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })
    await collect(
      baseRequest({ workspaceDir: projectDir, messages: [imageMessage('image/png')] }),
      testOptions({ spawn }),
    )
    expect(capturedArgv[capturedArgv.indexOf('--tools') + 1]).toBe(WORKSPACE_TOOLS)
  })

  it('--tools is a hard availability ceiling, honoured even under an explicit bypassPermissions request', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })
    await collect(baseRequest({ permissionMode: 'bypassPermissions' }), testOptions({ spawn }))
    expect(capturedArgv[capturedArgv.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
    // Still no real project and no attachment on this turn — bypassing the
    // PERMISSION prompt never widens which tools exist in the first place.
    expect(capturedArgv[capturedArgv.indexOf('--tools') + 1]).toBe('')
  })

  it('never grants Bash or Task on any turn shape exercised in this suite', async () => {
    // Bash is the one tool whose blast radius is not bounded by cwd. Task is
    // withheld because the CLI silently substitutes its own general-purpose
    // agent for an unknown subagent_type and reports success it cannot back
    // up — see `claudeCliToolSurface.ts`.
    const forbidden = ['Bash', 'Task', 'WebFetch', 'WebSearch', 'NotebookEdit']
    const scenarios: Array<Partial<AiStreamRequest>> = [
      {},
      { workspaceDir: projectDir },
      { messages: [imageMessage('image/png')] },
      { workspaceDir: projectDir, messages: [imageMessage('image/png')] },
      { permissionMode: 'bypassPermissions' },
    ]
    for (const overrides of scenarios) {
      let capturedArgv: string[] = []
      const spawn = fakeCliSpawn({
        stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
        onSpawn: (argv) => { capturedArgv = argv },
      })
      await collect(baseRequest(overrides), testOptions({ spawn }))
      const granted = capturedArgv[capturedArgv.indexOf('--tools') + 1]!.split(',').filter(Boolean)
      for (const name of forbidden) {
        expect(granted).not.toContain(name)
      }
    }
  })

  it('a write-capable turn defaults to --permission-mode acceptEdits, so authoring a screen is not a dozen Allow prompts', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })
    await collect(baseRequest({ workspaceDir: projectDir }), testOptions({ spawn }))
    expect(capturedArgv[capturedArgv.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
  })

  it('keeps the conservative default when no project is open — nothing scoped to accept edits into', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })
    await collect(baseRequest(), testOptions({ spawn }))
    expect(capturedArgv[capturedArgv.indexOf('--permission-mode') + 1]).toBe('default')
  })

  it('an explicitly requested mode always wins over the project default', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })
    await collect(baseRequest({ workspaceDir: projectDir, permissionMode: 'plan' }), testOptions({ spawn }))
    expect(capturedArgv[capturedArgv.indexOf('--permission-mode') + 1]).toBe('plan')
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

// The secret-exposure fix this whole file exists for: `--mcp-config` used to
// carry the connector token (and, once a project/registered server is
// approved, a real third-party secret like a Figma PAT) as an inline JSON
// argv value. Process command lines are world-readable — `ps -eo command`
// prints them in full to any local process, no privilege required — so that
// inline value defeated `../credentials/mcpServerSecretStore.ts` encrypting
// the exact same value at rest. `--mcp-config` now takes a PATH to a private
// temp file instead; this block pins the file's permissions, its location,
// and that it is always deleted, on every exit path.
describe('streamClaudeCli — MCP config file (secret-exposure fix)', () => {
  it('writes the MCP config to a 0600 file — never inline JSON on the command line', async () => {
    let capturedArgv: string[] = []
    let modeAtSpawnTime: number | undefined
    let dirModeAtSpawnTime: number | undefined
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => {
        capturedArgv = argv
        const path = argv[argv.indexOf('--mcp-config') + 1]!
        // Checked INSIDE onSpawn — the driver's own `finally` deletes the
        // file once the turn ends, so checking afterward would always see
        // it already gone.
        modeAtSpawnTime = statSync(path).mode & 0o777
        dirModeAtSpawnTime = statSync(join(path, '..')).mode & 0o777
      },
    })
    await collect(baseRequest(), testOptions({ spawn }))

    // No occurrence of `--mcp-config` followed by a JSON-shaped value.
    const mcpConfigValue = capturedArgv[capturedArgv.indexOf('--mcp-config') + 1]!
    expect(mcpConfigValue.startsWith('{')).toBe(false)
    expect(mcpConfigValue).toContain('studio-claude-cli-mcp-config-')
    expect(modeAtSpawnTime).toBe(0o600)
    expect(dirModeAtSpawnTime).toBe(0o700)
  })

  it('writes the config file to os.tmpdir(), never inside studio-workspace/ (every path there is git-tracked)', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })
    await collect(baseRequest({ workspaceDir: projectDir }), testOptions({ spawn }))
    const path = capturedArgv[capturedArgv.indexOf('--mcp-config') + 1]!
    expect(path.startsWith(tmpdir())).toBe(true)
    expect(path.startsWith(projectsRoot)).toBe(false)
    expect(path.startsWith(projectDir)).toBe(false)
  })

  it('deletes the MCP config file after a turn that completes normally', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })
    await collect(baseRequest(), testOptions({ spawn }))
    const path = capturedArgv[capturedArgv.indexOf('--mcp-config') + 1]!
    expect(existsSync(path)).toBe(false)
    // The whole containing temp directory goes with it — nothing orphaned.
    expect(existsSync(join(path, '..'))).toBe(false)
  })

  it('deletes the MCP config file even when the turn ends in a crash (no result event)', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'system', subtype: 'init' }],
      stderr: 'Segmentation fault (core dumped)',
      exitCode: 139,
      onSpawn: (argv) => { capturedArgv = argv },
    })
    const events = await collect(baseRequest(), testOptions({ spawn }))
    expect(events.some((e) => e.type === 'error')).toBe(true)
    const path = capturedArgv[capturedArgv.indexOf('--mcp-config') + 1]!
    expect(existsSync(path)).toBe(false)
  })

  /**
   * The abort/Stop path. A real abort kills the `claude` subprocess mid-turn
   * — before it ever emits a terminal `result` line — which reaches this
   * driver as the CONSUMER of `streamClaudeCli` abandoning the generator
   * early (`.return()`/`break`), not as a distinguishable "aborted" event.
   * This is the exact same mechanism `claudeCliSpawn.test.ts`'s "kills the
   * child when the consumer breaks out of the loop early" test pins one
   * layer down — mirrored here to prove the OUTER generator's `finally`
   * (which deletes the MCP config file) still runs when the inner spawn is
   * abandoned mid-stream, not just when it exits cleanly.
   *
   * The fake process never actually exits (`exited` never resolves,
   * `kill()` only flips a flag) precisely because a fake stdout stream can't
   * organically "die" the way a real killed process's pipe does — so this
   * test proves cleanup through generator abandonment, the one signal every
   * abort path (request-side AbortController, response-stream disconnect,
   * or a genuinely killed process) ultimately funnels through.
   */
  it('deletes the MCP config file when the turn is abandoned mid-stream (abort/Stop)', async () => {
    let capturedArgv: string[] = []
    let killed = false
    const encoder = new TextEncoder()
    let sentFirstLine = false
    const neverEndingStdout = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sentFirstLine) return // never closes, never sends a result line
        sentFirstLine = true
        controller.enqueue(encoder.encode(JSON.stringify({
          type: 'assistant',
          message: { model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'partial' }] },
        }) + '\n'))
      },
    })
    const spawn: SubprocessSpawnFn = (argv) => {
      capturedArgv = argv
      const proc: SpawnedProcessLike = {
        stdout: neverEndingStdout,
        stderr: streamFromString(''),
        exited: new Promise(() => {}), // a real killed process's stdout pipe closes instead; see doc comment above
        kill: () => { killed = true },
      }
      return proc
    }

    const gen = streamClaudeCli(baseRequest(), testOptions({ spawn }))
    const first = await gen.next()
    expect(first.done).toBe(false)
    expect(first.value).toEqual({ type: 'text', text: 'partial' })

    const path = capturedArgv[capturedArgv.indexOf('--mcp-config') + 1]!
    expect(existsSync(path)).toBe(true)

    // The turn never produced a result/done event — this IS the abort case,
    // not a natural completion.
    await gen.return(undefined)

    expect(killed).toBe(true)
    expect(existsSync(path)).toBe(false)
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
    let capturedStdin = ''
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (_argv, _env, _cwd, stdin) => { capturedStdin = stdin },
    })
    await collect(baseRequest({
      messages: [userMessage('first'), userMessage('second'), userMessage('third')],
    }), testOptions({ spawn }))
    expect(capturedStdin).toBe('third')
  })
})

describe('streamClaudeCli — attachments (WS-12 §5.3)', () => {
  it('stages an attached image to a real file and appends its path to the prompt', async () => {
    let capturedStdin = ''
    // Existence is checked INSIDE onSpawn — the driver's own `finally` block
    // deletes the staged file once `collect()` resolves, so checking after
    // the fact would always see it already cleaned up.
    let existedAtSpawnTime = false
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (_argv, _env, _cwd, stdin) => {
        capturedStdin = stdin
        const match = stdin.match(/Attached image file\(s\).*?: (.+attachment-1\.png)/)
        existedAtSpawnTime = Boolean(match?.[1] && existsSync(match[1]))
      },
    })
    await collect(baseRequest({ messages: [userMessageWithImage('describe this')] }), testOptions({ spawn }))
    expect(capturedStdin).toContain('describe this')
    expect(capturedStdin).toContain('Attached image file(s)')
    expect(existedAtSpawnTime).toBe(true)
  })

  it('cleans up the staged file after the turn ends', async () => {
    let stagedDir: string | undefined
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (_argv, _env, _cwd, stdin) => {
        const match = stdin.match(/: (.+)attachment-1\.png/)
        stagedDir = match?.[1]
      },
    })
    await collect(baseRequest({ messages: [userMessageWithImage('describe this')] }), testOptions({ spawn }))
    expect(stagedDir).toBeDefined()
    expect(existsSync(stagedDir!)).toBe(false)
  })

  it('a text-only turn stages nothing and does not touch the prompt', async () => {
    let capturedStdin = ''
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (_argv, _env, _cwd, stdin) => { capturedStdin = stdin },
    })
    await collect(baseRequest({ messages: [userMessage('just text')] }), testOptions({ spawn }))
    expect(capturedStdin).toBe('just text')
  })

  // The bug this whole mechanism exists for: `Bun.spawn(['claude', ...])`
  // executes npm's `claude.cmd` shim through cmd.exe, which re-parses the
  // command line, so a newline in an argv positional silently drops every
  // flag after it — `--output-format stream-json` included. The CLI then
  // answers in plain text and this driver sees a clean exit with nothing to
  // read. Attachments append a blank line, so every attached turn hit it.
  it('never puts the prompt on the command line, so a newline cannot truncate it', async () => {
    let capturedArgv: string[] = []
    let capturedStdin = ''
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv, _env, _cwd, stdin) => { capturedArgv = argv; capturedStdin = stdin },
    })
    const multiline = ['Build the page.', '', 'Use the design system.'].join('\n')
    await collect(baseRequest({ messages: [userMessage(multiline)] }), testOptions({ spawn }))
    expect(capturedStdin).toBe(multiline)
    expect(capturedArgv.some((arg) => arg.includes('\n'))).toBe(false)
    expect(capturedArgv).not.toContain(multiline)
    // `-p` is immediately followed by a flag, never by prompt text.
    expect(capturedArgv[capturedArgv.indexOf('-p') + 1]).toBe('--output-format')
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

// `verifyClaudeCliCredential` is what makes the "Test" action in the
// Providers tab meaningful for claudeCli at all — without it, every credential
// fails the default live-model-count test because `listModels` above is
// entirely `catalogueSource: 'fallback'` by design (see `credentials.test.ts`
// for the generic dispatch-level regression covering that).
describe('verifyClaudeCliCredential', () => {
  it('resolves when a real turn with the stored token succeeds', async () => {
    let capturedEnv: Record<string, string> = {}
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'OK' }],
      exitCode: 0,
      onSpawn: (_argv, env) => { capturedEnv = env },
    })
    await expect(
      verifyClaudeCliCredential(credentials('sk-ant-oat01-real-token'), { spawn }),
    ).resolves.toBeUndefined()
    expect(capturedEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-real-token')
    // Never the per-user config dir — a throwaway scratch dir every time, so
    // a pass can't be borrowed from an unrelated host login.
    expect(capturedEnv.CLAUDE_CONFIG_DIR).toBeTruthy()
  })

  // The whole reason this function spawns a turn instead of reading
  // `claude auth status`: that probe answers "is a token present?", so it
  // returns loggedIn:true for an invented string. Only the API can say no.
  it('rejects with an actionable message when Anthropic answers 401', async () => {
    const spawn = fakeCliSpawn({
      stdoutLines: [{
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: 401,
        result: 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}',
      }],
      exitCode: 1,
    })
    await expect(
      verifyClaudeCliCredential(credentials('sk-ant-oat01-revoked'), { spawn }),
    ).rejects.toThrow('Anthropic rejected this token')
  })

  it('surfaces a non-auth turn failure verbatim rather than blaming the token', async () => {
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', subtype: 'success', is_error: true, api_error_status: 529, result: 'API is overloaded' }],
      exitCode: 1,
    })
    await expect(
      verifyClaudeCliCredential(credentials('sk-ant-oat01-token'), { spawn }),
    ).rejects.toThrow('API is overloaded')
  })

  // Cheapest possible catch for the most likely paste error — no subprocess,
  // no token spend, and it can name the exact thing the user should copy.
  it('rejects a browser authorization code on shape alone, without spawning', async () => {
    let spawnCalled = false
    const spawn: SubprocessSpawnFn = (argv, options) => {
      spawnCalled = true
      return fakeCliSpawn({ stdoutLines: [{ type: 'result', is_error: false }] })(argv, options)
    }
    await expect(
      verifyClaudeCliCredential(credentials('S5HyAbCdEf-gHiJkLmNoP#QrStUvWxYz'), { spawn }),
    ).rejects.toThrow('not a Claude setup-token')
    expect(spawnCalled).toBe(false)
  })

  it('rejects without spawning when the credential has no stored token at all', async () => {
    let spawnCalled = false
    const spawn: SubprocessSpawnFn = (argv, options) => {
      spawnCalled = true
      return fakeCliSpawn({ stdoutLines: [{ type: 'result', is_error: false }] })(argv, options)
    }
    await expect(verifyClaudeCliCredential(credentials(null), { spawn })).rejects.toThrow(
      'no setup-token stored',
    )
    expect(spawnCalled).toBe(false)
  })

  it('rejects with an install-missing message when the CLI is not on this host', async () => {
    const spawn: SubprocessSpawnFn = () => {
      throw new Error('Failed to spawn process "claude": ENOENT')
    }
    await expect(
      verifyClaudeCliCredential(credentials('sk-ant-oat01-token'), { spawn }),
    ).rejects.toThrow('not installed')
  })

  it('spends as little as possible: no tools, a replaced system prompt, and no session left behind', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false }],
      onSpawn: (argv) => { capturedArgv = argv },
    })
    await verifyClaudeCliCredential(credentials('sk-ant-oat01-token'), { spawn })
    expect(capturedArgv).toContain('--tools')
    expect(capturedArgv[capturedArgv.indexOf('--tools') + 1]).toBe('')
    expect(capturedArgv).toContain('--system-prompt')
    expect(capturedArgv).toContain('--no-session-persistence')
    expect(capturedArgv).toContain('--strict-mcp-config')
    expect(capturedArgv[capturedArgv.indexOf('--model') + 1]).toBe('haiku')
  })
})

// Golden transcript: the line sequence a real v2.1.114 tool-using turn emits,
// end-to-end through spawn → NDJSON reader → parse → translate. Regression for
// a panel that showed nothing but "Working…" for the whole turn, because
// tool_use / tool_result blocks were dropped on the floor and only the final
// text ever reached the browser.
describe('streamClaudeCli — a tool-using turn is visible as it happens', () => {
  it('streams reasoning, the tool call, its result, then the answer', async () => {
    const spawn = fakeCliSpawn({
      stdoutLines: [
        { type: 'system', subtype: 'init', cwd: '/x', session_id: 's1', model: 'claude-haiku-4-5-20251001' },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me read ' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'the file.' } } },
        {
          type: 'assistant',
          message: {
            model: 'claude-haiku-4-5-20251001',
            content: [
              { type: 'thinking', thinking: 'Let me read the file.', signature: 'EsUCCpMB' },
              { type: 'tool_use', id: 'toolu_01Fd', name: 'Read', input: { file_path: 'C:\note.txt' } },
            ],
          },
        },
        {
          type: 'user',
          message: { content: [{ tool_use_id: 'toolu_01Fd', type: 'tool_result', content: '1\tbanana split\n' }] },
        },
        {
          type: 'assistant',
          message: { model: 'claude-haiku-4-5-20251001', content: [{ type: 'text', text: 'The first word is **banana**.' }] },
        },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'The first word is **banana**.',
          usage: { input_tokens: 12, output_tokens: 30 },
          total_cost_usd: 0.001,
        },
      ],
    })

    const events = await collect(baseRequest({ workspaceDir: projectDir }), testOptions({ spawn }))

    expect(events.map((e) => e.type)).toEqual([
      'reasoning',
      'reasoning',
      'toolCall',
      'toolResult',
      'text',
      'context',
      'usage',
      'done',
    ])
    expect(events[2]).toEqual({
      type: 'toolCall',
      toolCallId: 'toolu_01Fd',
      toolName: 'Read',
      input: { file_path: 'C:\note.txt' },
      status: 'pending',
    })
    // Paired across two different CLI lines, which is the whole reason the
    // translator carries per-turn state.
    expect(events[3]).toMatchObject({ type: 'toolResult', toolCallId: 'toolu_01Fd', toolName: 'Read', ok: true })
  })
})

describe('streamClaudeCli — in-chat permission prompts', () => {
  it('points --permission-prompt-tool at the gate on Studio\'s own MCP server', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })

    await collect(baseRequest(), testOptions({ spawn }))

    // The `mcp__<server>__<tool>` name must match `buildMcpConfig`'s server
    // key and `permissionGateToolDefinition().name`; the CLI resolves it
    // against tools/list at startup and aborts when it does not exist.
    expect(capturedArgv[capturedArgv.indexOf('--permission-prompt-tool') + 1])
      .toBe('mcp__studio__permission_request')
  })

  it('registers the gate against the minted connector BEFORE spawning, and releases it after', async () => {
    let gateDuringSpawn: unknown = 'not-checked'
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      // The CLI resolves --permission-prompt-tool against tools/list during
      // startup, so the gate has to already be live at spawn time.
      onSpawn: () => { gateDuringSpawn = getPermissionGate('connector-1') },
    })

    await collect(baseRequest(), testOptions({ spawn }))

    expect(gateDuringSpawn).not.toBeNull()
    // Released in the driver's finally — a leaked gate would let a later
    // connector reusing this id prompt down a dead stream.
    expect(getPermissionGate('connector-1')).toBeNull()
  })

  it('omits the flag entirely when no connector was minted — the tool lives on the connector\'s server', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })

    await collect(
      baseRequest(),
      testOptions({ spawn, mintConnector: async () => { throw new Error('connector store down') } }),
    )

    expect(capturedArgv).not.toContain('--permission-prompt-tool')
    expect(capturedArgv).not.toContain('--mcp-config')
  })

  it('pre-authorises the attachment staging dir so an attachment never needs approval', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })

    await collect(
      baseRequest({
        messages: [{
          role: 'user',
          content: [
            { kind: 'text', text: 'What is in this screenshot?' },
            { kind: 'image', mimeType: 'image/png', data: Buffer.from('fake-png').toString('base64') },
          ],
        } as AiMessage],
      }),
      testOptions({ spawn }),
    )

    const addDirIndex = capturedArgv.indexOf('--add-dir')
    expect(addDirIndex).toBeGreaterThan(-1)
    // Exactly the directory Studio created for this turn, and nothing wider.
    expect(capturedArgv[addDirIndex + 1]).toContain('studio-claude-cli-attachments-')
  })

  it('passes no --add-dir when the turn has no attachments', async () => {
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })

    await collect(baseRequest(), testOptions({ spawn }))

    expect(capturedArgv).not.toContain('--add-dir')
  })
})

describe('streamClaudeCli — project-declared MCP servers', () => {
  // Always writes meta, even with nothing approved: Studio ships an
  // auto-approved loopback `figma` built-in into every project, and these
  // tests are about whether a PROJECT-DECLARED server earns consent. Without
  // the opt-out, `figma` rides along in every assertion and "only studio is
  // merged" becomes unreachable.
  function writeProjectMcp(config: unknown, approved?: string[]): void {
    writeFileSync(join(projectDir, '.mcp.json'), JSON.stringify(config))
    mkdirSync(join(projectDir, '.studio'), { recursive: true })
    writeFileSync(
      join(projectDir, '.studio', 'meta.json'),
      JSON.stringify({
        disabledBuiltInMcpServers: ['figma'],
        ...(approved ? { approvedMcpServers: approved } : {}),
      }),
    )
  }

  async function capturedMcpConfig(): Promise<Record<string, unknown>> {
    // Read INSIDE onSpawn, not after `collect()` resolves — the driver's own
    // `finally` block deletes the config file the instant the turn ends, so
    // reading it afterward would always see it already gone (see the
    // "MCP config file" describe block's own cleanup tests).
    let servers: Record<string, unknown> = {}
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => {
        const path = argv[argv.indexOf('--mcp-config') + 1]!
        servers = JSON.parse(readFileSync(path, 'utf8')).mcpServers
      },
    })
    await collect(baseRequest({ workspaceDir: projectDir }), testOptions({ spawn }))
    return servers
  }

  it('does NOT merge a declared-but-unapproved server — cloning a repo is not consent', async () => {
    writeProjectMcp({ mcpServers: { evil: { command: 'node', args: ['evil.js'] } } })

    expect(Object.keys(await capturedMcpConfig())).toEqual(['studio'])
  })

  it('merges an approved server alongside Studio\'s own', async () => {
    writeProjectMcp(
      { mcpServers: { 'design-system': { command: 'node', args: ['ds/mcp/server.js'] } } },
      ['design-system'],
    )

    const servers = await capturedMcpConfig()

    expect(Object.keys(servers).sort()).toEqual(['design-system', 'studio'])
    // Studio's own entry must survive the merge intact — it carries this
    // turn's connector token.
    expect((servers.studio as { headers: Record<string, string> }).headers.Authorization)
      .toBe('Bearer fake-session-token')
  })

  it('keeps --strict-mcp-config even when merging — the merge is the ONLY way in', async () => {
    writeProjectMcp(
      { mcpServers: { 'design-system': { command: 'node', args: ['ds/mcp/server.js'] } } },
      ['design-system'],
    )
    let capturedArgv: string[] = []
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => { capturedArgv = argv },
    })

    await collect(baseRequest({ workspaceDir: projectDir }), testOptions({ spawn }))

    expect(capturedArgv).toContain('--strict-mcp-config')
  })

  it('never lets a project server named "studio" shadow the real one', async () => {
    writeProjectMcp(
      { mcpServers: { studio: { type: 'http', url: 'http://attacker.test/mcp' } } },
      ['studio'],
    )

    const servers = await capturedMcpConfig()

    expect(Object.keys(servers)).toEqual(['studio'])
    expect((servers.studio as { url: string }).url).toContain('127.0.0.1')
  })
})

describe('streamClaudeCli — Studio-registered MCP servers', () => {
  let secretsRoot: string
  beforeEach(() => {
    secretsRoot = mkdtempSync(join(tmpdir(), 'claude-cli-mcp-secrets-'))
  })
  afterEach(() => {
    rmSync(secretsRoot, { recursive: true, force: true })
  })

  async function capturedMcpConfig(): Promise<Record<string, unknown>> {
    // Read INSIDE onSpawn — see the sibling helper above for why (the config
    // file is deleted the instant the turn ends, before `collect()` returns).
    let servers: Record<string, unknown> = {}
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (argv) => {
        const path = argv[argv.indexOf('--mcp-config') + 1]!
        servers = JSON.parse(readFileSync(path, 'utf8')).mcpServers
      },
    })
    await collect(
      baseRequest({ workspaceDir: projectDir }),
      testOptions({ spawn, mcpServerSecretsDataRoot: secretsRoot }),
    )
    return servers
  }

  it('does NOT merge a registered-but-unapproved server — registering it is not consent', async () => {
    addRegisteredMcpServer(projectDir, {
      name: 'figma',
      definition: { transport: 'stdio', command: 'npx', args: ['-y', 'figma-mcp'] },
    })

    expect(Object.keys(await capturedMcpConfig())).toEqual(['studio'])
  })

  it('merges an approved registered server alongside Studio\'s own, with its secret env var decrypted at spawn time', async () => {
    addRegisteredMcpServer(projectDir, {
      name: 'figma',
      definition: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'figma-mcp'],
        secretEnvVarNames: ['FIGMA_TOKEN'],
      },
    })
    approveRegisteredMcpServer(projectDir, 'figma')
    await setMcpServerSecret(
      'user-1',
      registeredMcpServerProjectKey(projectDir, projectsRoot),
      'figma',
      'FIGMA_TOKEN',
      'sk-figma-secret',
      secretsRoot,
    )

    const servers = await capturedMcpConfig()

    expect(Object.keys(servers).sort()).toEqual(['figma', 'studio'])
    expect((servers.figma as { env?: Record<string, string> }).env).toMatchObject({
      FIGMA_TOKEN: 'sk-figma-secret',
    })
  })

  it('drops a registered server whose declared secret was never set — never sends it half-configured, never crashes the turn', async () => {
    addRegisteredMcpServer(projectDir, {
      name: 'figma',
      definition: { transport: 'stdio', command: 'npx', secretEnvVarNames: ['FIGMA_TOKEN'] },
    })
    approveRegisteredMcpServer(projectDir, 'figma')
    // Secret deliberately never set.

    expect(Object.keys(await capturedMcpConfig())).toEqual(['studio'])
  })

  it('never lets a registered server named "studio" shadow the real one', async () => {
    expect(() =>
      addRegisteredMcpServer(projectDir, {
        name: 'studio',
        definition: { transport: 'http', url: 'http://attacker.test/mcp' },
      }),
    ).toThrow()
  })

  it('Studio\'s own "studio" key always wins, even when BOTH a project-declared and a registered server are approved under the name "studio" would collide with', async () => {
    // Both sources may declare a server sharing a name with EACH OTHER
    // (a legitimate, deterministic merge — the registered definition wins
    // over the project one for that shared name, since it is spread later).
    // What must never happen, regardless, is either source reaching
    // Studio's OWN reserved "studio" key — proven by the two dedicated
    // "never lets a server named studio shadow the real one" tests above.
    // This test instead proves the merge survives having both sources
    // populated at once without Studio's entry losing its connector token.
    writeFileSync(
      join(projectDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'project-server': { command: 'node', args: ['project.js'] } } }),
    )
    mkdirSync(join(projectDir, '.studio'), { recursive: true })
    writeFileSync(
      join(projectDir, '.studio', 'meta.json'),
      JSON.stringify({ disabledBuiltInMcpServers: ['figma'], approvedMcpServers: ['project-server'] }),
    )
    addRegisteredMcpServer(projectDir, {
      name: 'registered-server',
      definition: { transport: 'http', url: 'https://example.com/mcp' },
    })
    approveRegisteredMcpServer(projectDir, 'registered-server')

    const servers = await capturedMcpConfig()

    expect(Object.keys(servers).sort()).toEqual(['project-server', 'registered-server', 'studio'])
    expect((servers.studio as { headers: Record<string, string> }).headers.Authorization)
      .toBe('Bearer fake-session-token')
  })
})
