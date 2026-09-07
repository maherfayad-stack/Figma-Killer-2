/**
 * A fake `claude` binary, for measuring the part of a chat turn Studio owns.
 *
 * A real turn's wall time is dominated by the model, which is neither
 * reproducible nor Studio's to optimise. What IS Studio's — and what W9-1's
 * three shipped optimisations moved — is everything the server does before the
 * subprocess can answer: project-guide generation, workspace containment,
 * turn routing, config-dir preparation, session-id derivation and the
 * transcript probe, connector minting, MCP config assembly and its 0600 temp
 * file, argv assembly, and (cold only) a fresh process plus a fresh MCP
 * handshake for every attached server.
 *
 * So this stands in for the binary at the SAME seam the driver's own tests use
 * (`StreamClaudeCliOptions.spawn`), answering both ways production talks to it:
 *
 *   - **cold** — `stdin` carries the prompt bytes, the process answers once
 *     and exits;
 *   - **warm** — `stdin: 'pipe'`, silent until an NDJSON user frame arrives,
 *     then one answer per frame, process stays alive.
 *
 * It answers instantly, so a measured turn is Studio's own overhead and
 * nothing else. That is the honest reading of every number it produces: NOT
 * "how long a turn takes", but "how much of a turn Studio pays for before the
 * model has said a word".
 *
 * It also counts what a turn costs the MCP layer, by reading the real
 * `--mcp-config` file off the argv it was spawned with, at spawn time (the
 * driver deletes it in its own `finally`). Every server in that file is one
 * `initialize` + `tools/list` handshake the CLI performs on startup — which is
 * why "spawns per turn" and "MCP servers attached per spawn" multiply out to
 * the per-turn MCP round-trip count, and why a warm session paying it once per
 * conversation rather than once per turn is the whole point of the pool.
 */
import { readFileSync } from 'node:fs'
import type { SpawnedProcessLike, SubprocessSpawnFn } from '../../../server/handlers/studio/subprocessRunner'

/** What one bench run observed about the subprocesses the driver started. */
export interface FakeCliCounters {
  /** Processes started. One per cold turn; one per warm SESSION. */
  spawns: number
  /** Turns actually served (a warm process serves many). */
  turnsServed: number
  /** MCP config files the driver wrote — one per spawn that had a connector. */
  mcpConfigWrites: number
  /** Servers declared in each config written, in spawn order. */
  serversPerSpawn: number[]
  /** Every server name seen across all spawns, deduplicated. */
  serverNames: Set<string>
}

export function newFakeCliCounters(): FakeCliCounters {
  return { spawns: 0, turnsServed: 0, mcpConfigWrites: 0, serversPerSpawn: [], serverNames: new Set() }
}

/** The stdout a turn answers with — the exact event shapes `claudeCliEvents.ts` translates. */
const TURN_STDOUT_LINES: readonly object[] = [
  { type: 'system', subtype: 'init', cwd: '/bench', session_id: 'bench-session', model: 'claude-sonnet-4-6' },
  { type: 'assistant', message: { model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'Done.' }] } },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Done.',
    usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    total_cost_usd: 0.001,
  },
]

function turnStdout(): string {
  return TURN_STDOUT_LINES.map((line) => JSON.stringify(line)).join('\n') + '\n'
}

function streamFromString(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/**
 * Read the MCP config this spawn was handed, while it still exists. Counted
 * rather than kept: the file carries a freshly-minted bearer token.
 */
function recordMcpConfig(argv: readonly string[], counters: FakeCliCounters): void {
  const index = argv.indexOf('--mcp-config')
  const path = index >= 0 ? argv[index + 1] : undefined
  if (!path) return
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const servers =
      parsed && typeof parsed === 'object' && 'mcpServers' in parsed
        ? (parsed as { mcpServers?: Record<string, unknown> }).mcpServers ?? {}
        : {}
    const names = Object.keys(servers)
    counters.mcpConfigWrites += 1
    counters.serversPerSpawn.push(names.length)
    for (const name of names) counters.serverNames.add(name)
  } catch {
    // The driver had already cleaned it up, or never wrote one — not a
    // measurement this bench can fabricate, so it simply goes uncounted.
  }
}

/** A fake `claude` that serves both the cold and the warm protocol, counting as it goes. */
export function fakeClaudeCliSpawn(counters: FakeCliCounters): SubprocessSpawnFn {
  return (argv, options) => {
    counters.spawns += 1
    recordMcpConfig(argv, counters)

    if (options.stdin !== 'pipe') {
      counters.turnsServed += 1
      return {
        stdout: streamFromString(turnStdout()),
        stderr: streamFromString(''),
        exited: Promise.resolve(0),
        kill: () => {},
      }
    }

    let stdoutController: ReadableStreamDefaultController<Uint8Array> | null = null
    let exitProcess: (code: number) => void = () => {}
    const proc: SpawnedProcessLike = {
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          stdoutController = controller
        },
      }),
      stderr: streamFromString(''),
      exited: new Promise<number>((resolve) => {
        exitProcess = resolve
      }),
      stdin: {
        write: (chunk) => {
          const frame: unknown = JSON.parse(new TextDecoder().decode(chunk))
          if (!frame || typeof frame !== 'object' || (frame as { type?: string }).type !== 'user') return
          counters.turnsServed += 1
          stdoutController?.enqueue(new TextEncoder().encode(turnStdout()))
        },
        flush: () => {},
        end: () => {},
      },
      kill: () => {
        try {
          stdoutController?.close()
        } catch {
          // already closed
        }
        exitProcess(143)
      },
    }
    return proc
  }
}
