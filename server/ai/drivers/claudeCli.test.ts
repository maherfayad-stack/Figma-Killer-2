/**
 * claudeCli.ts — the AiProvider `stream()` implementation end-to-end, with
 * an injected fake spawn (never the real `claude` binary, never a real
 * subprocess). Fixtures use the exact CLI event shapes WS-11 §4.0 verified.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AiMessage } from '../runtime/types'
import type { AiResolvedCredential, AiStreamRequest } from './types'
import type { SpawnedProcessLike, SubprocessSpawnFn } from '../../handlers/studio/subprocessRunner'
import { claudeCliDriver, streamClaudeCli } from './claudeCli'

let dataRoot: string
beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'claude-cli-driver-test-'))
})
afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true })
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
      capabilities: [],
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

    const events = await collect(baseRequest(), { spawn, dataRoot })

    expect(events).toEqual([
      { type: 'text', text: 'Hi there.' },
      { type: 'context', promptTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
      { type: 'usage', promptTokens: 50, completionTokens: 10, costUsd: 0.002, cacheReadTokens: 0, cacheCreationTokens: 0 },
      { type: 'done' },
    ])

    // Spawn shape — WS-11 §4.0 (trimmed to step 1's argv, see file doc comment).
    expect(capturedArgv).toEqual([
      'claude', '-p', 'Hello, Claude.',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', 'sonnet',
      '--permission-mode', 'default',
      '--strict-mcp-config',
    ])
    expect(capturedEnv.CLAUDE_CONFIG_DIR).toBe(join(dataRoot, 'user-1'))
    expect(capturedEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('token-abc')
    // No project cwd is threaded through yet (step 1) — spawns inside the
    // per-user config dir, never a real project.
    expect(capturedCwd).toBe(join(dataRoot, 'user-1'))
  })

  it('omits CLAUDE_CODE_OAUTH_TOKEN when the credential carries no apiKey (the L1 shape)', async () => {
    let capturedEnv: Record<string, string> = {}
    const spawn = fakeCliSpawn({
      stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
      onSpawn: (_argv, env) => { capturedEnv = env },
    })
    await collect(baseRequest({ credentials: credentials(null) }), { spawn, dataRoot })
    expect(capturedEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(capturedEnv.CLAUDE_CONFIG_DIR).toBeTruthy()
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
    const events = await collect(baseRequest(), { spawn, dataRoot })
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
    const events = await collect(baseRequest(), { spawn, dataRoot })
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
    const events = await collect(baseRequest(), {
      spawn,
      dataRoot,
      platformSupport: { supported: false, reason: 'macOS cannot isolate Claude CLI logins per user.' },
    })
    expect(spawnCalled).toBe(false)
    expect(events).toEqual([{ type: 'error', message: 'macOS cannot isolate Claude CLI logins per user.' }])
  })
})

describe('streamClaudeCli — defensive credential-shape guard', () => {
  it('refuses a baseUrl-mode credential', async () => {
    const events = await collect(
      baseRequest({ credentials: { id: 'c', providerId: 'claudeCli', authMode: 'baseUrl', apiKey: null, baseUrl: 'http://x' } }),
      { dataRoot },
    )
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('error')
  })
})

describe('streamClaudeCli — prompt assembly', () => {
  it('errors when there is no user message to send', async () => {
    const events = await collect(baseRequest({ messages: [] }), { dataRoot })
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
    }), { spawn, dataRoot })
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
