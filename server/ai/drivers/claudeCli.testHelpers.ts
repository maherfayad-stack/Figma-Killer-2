/**
 * Test-only: a fake `claude` binary, and a harness that runs real
 * `streamClaudeCli` turns against it and reports what each spawned process
 * was given.
 *
 * Shared by the driver's own suite (`claudeCli.test.ts`,
 * `claudeCliSystemPrompt.test.ts`) and the architecture gates that must assert
 * what the CLI RECEIVES rather than what a prompt builder returns
 * (`cli-receives-mode-and-policy.test.ts`,
 * `studio-agent-subagent-contract.test.ts`). A gate that checked the prompt
 * builder alone passed for months while none of that text reached the CLI
 * (audit 06, AI-1 and AI-3); the only honest check drives the driver itself.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpawnedProcessLike, SubprocessSpawnFn } from '../../handlers/studio/subprocessRunner'
import type { AiStreamRequest } from './types'
import { streamClaudeCli } from './claudeCli'
import { disposeAllWarmSessions } from './claudeCliSessionPool'

export function streamFromString(text: string): ReadableStream<Uint8Array> {
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

/**
 * A fake `claude` that answers BOTH ways the driver can talk to it, because
 * production uses both: a warm session (`stdin: 'pipe'`, one NDJSON line per
 * turn, process stays alive) and a cold turn (`stdin: <bytes>`, answer once,
 * exit). Injecting one fake through the single `spawn` seam is what lets the
 * suite assert that argv, the MCP config, and the connector lifecycle are
 * identical on both.
 *
 * `onSpawn`'s fourth argument is the PROMPT either way — extracted from the
 * NDJSON envelope on the warm path — so every assertion about what the user's
 * turn contained means the same thing on both paths. On the warm path it fires
 * once per TURN, not once per process.
 */
export function fakeCliSpawn(opts: FakeCliOptions): SubprocessSpawnFn {
  const stdoutText = (): string => opts.stdoutLines.map((line) => JSON.stringify(line)).join('\n') + '\n'
  return (argv, options) => {
    if (options.stdin !== 'pipe') {
      // Cold: the prompt is piped up front, never an argv positional.
      const stdin = options.stdin === 'ignore' ? '' : new TextDecoder().decode(options.stdin)
      opts.onSpawn?.(argv, options.env, options.cwd, stdin)
      return {
        stdout: streamFromString(stdoutText()),
        stderr: streamFromString(opts.stderr ?? ''),
        exited: Promise.resolve(opts.exitCode ?? 0),
        kill: () => {},
      }
    }

    // Warm: nothing is emitted until a user line arrives, exactly as the real
    // binary behaves — a warm session discards anything queued before a turn
    // starts, so a fake that answered eagerly would test nothing.
    let stdoutController: ReadableStreamDefaultController<Uint8Array> | null = null
    let exitProcess: (code: number) => void = () => {}
    const proc: SpawnedProcessLike = {
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          stdoutController = controller
        },
      }),
      stderr: streamFromString(opts.stderr ?? ''),
      exited: new Promise<number>((resolve) => {
        exitProcess = resolve
      }),
      stdin: {
        write: (chunk) => {
          const frame = JSON.parse(new TextDecoder().decode(chunk))
          if (frame.type !== 'user') return
          opts.onSpawn?.(argv, options.env, options.cwd, frame.message.content[0].text)
          if ((opts.exitCode ?? 0) !== 0) {
            // A CLI that dies instead of answering — the warm path must fall
            // back to a cold spawn rather than surfacing a subprocess error.
            stdoutController?.close()
            exitProcess(opts.exitCode ?? 0)
            return
          }
          stdoutController?.enqueue(new TextEncoder().encode(stdoutText()))
        },
        flush: () => {},
        end: () => {},
      },
      kill: () => {
        try {
          stdoutController?.close()
        } catch {
          // Already closed.
        }
        exitProcess(143)
      },
    }
    return proc
  }
}

/** What one served turn was given. */
export interface CapturedCliTurn {
  /** The argv of the process that served the turn. */
  readonly argv: string[]
  /** The `--append-system-prompt-file` file's text, read while the turn ran; `null` when the flag was absent. */
  readonly appendedSystemPrompt: string | null
  /** The user-message text the turn carried. */
  readonly prompt: string
}

export interface CliTurnsCapture {
  readonly turns: CapturedCliTurn[]
  /** How many processes were started across all the turns — one per turn cold, fewer when a warm session was reused. */
  readonly spawns: number
}

/**
 * Run each `systemPrompt` as one real `streamClaudeCli` turn in ONE
 * conversation, with a real project open, against the fake binary.
 *
 * `warm: true` exercises the production default (a pooled process, reused
 * while its fingerprint holds); `warm: false` forces the cold path. Every
 * temp directory and warm session is torn down before this returns.
 */
export async function runClaudeCliTurns(
  systemPrompts: ReadonlyArray<readonly string[]>,
  opts: { readonly warm: boolean },
): Promise<CliTurnsCapture> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'claude-cli-capture-data-'))
  const projectsRoot = mkdtempSync(join(tmpdir(), 'claude-cli-capture-projects-'))
  const projectDir = join(projectsRoot, 'capture-project')
  mkdirSync(projectDir, { recursive: true })

  const turns: CapturedCliTurn[] = []
  let spawns = 0
  const fake = fakeCliSpawn({
    stdoutLines: [{ type: 'result', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } }],
    onSpawn: (argv, _env, _cwd, prompt) => {
      const flag = argv.indexOf('--append-system-prompt-file')
      turns.push({ argv, prompt, appendedSystemPrompt: flag === -1 ? null : readFileSync(argv[flag + 1]!, 'utf8') })
    },
  })
  const spawn: SubprocessSpawnFn = (argv, options) => {
    spawns += 1
    return fake(argv, options)
  }

  try {
    for (const systemPrompt of systemPrompts) {
      const request: AiStreamRequest = {
        systemPrompt: [...systemPrompt],
        messages: [{ role: 'user', content: [{ kind: 'text', text: 'Build the checkout screen' }] }],
        tools: [],
        modelId: 'sonnet',
        modelCapabilities: { toolCalling: true, visionInput: false, toolResultImages: false, promptCache: false, streaming: true },
        credentials: { id: 'cred-1', providerId: 'claudeCli', authMode: 'apiKey', apiKey: 'token-abc', baseUrl: null },
        signal: new AbortController().signal,
        bridge: { async callBrowser() { return { ok: false, error: 'unused' } } },
        workspaceDir: projectDir,
        toolContextBase: { db: {} as never, userId: 'capture-user', capabilities: ['ai.chat'], conversationId: 'capture-conv', snapshot: null },
      }
      for await (const _event of streamClaudeCli(request, {
        spawn,
        platformSupport: { supported: true },
        dataRoot,
        projectsRoot,
        serverPort: 3001,
        mintConnector: async () => ({ connectorId: 'capture-connector', token: 'capture-token' }),
        revokeConnector: async () => {},
        generateGuide: () => ({ written: [], skipped: [], pruned: [] }),
        disableWarmSession: !opts.warm,
      })) {
        // Drained for its side effects: the fake records what each turn was given.
      }
    }
    return { turns, spawns }
  } finally {
    await disposeAllWarmSessions()
    rmSync(dataRoot, { recursive: true, force: true })
    rmSync(projectsRoot, { recursive: true, force: true })
  }
}
