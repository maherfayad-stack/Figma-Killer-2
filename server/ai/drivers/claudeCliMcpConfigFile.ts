/**
 * The `--mcp-config` argument, written to a private temp FILE instead of
 * passed as inline JSON on argv.
 *
 * `buildMcpConfig` (`claudeCli.ts`) assembles an object carrying, in full
 * plaintext, this turn's session-connector bearer token and — once project
 * or registered MCP servers are approved — a live Figma personal access
 * token, a GitHub token, or whatever else a server definition's secret
 * fields resolve to. Passing that object as `--mcp-config <json>` puts every
 * one of those secrets into the child process's own argv, and argv is not
 * private: `ps -eo command` (no privilege required) prints the full command
 * line of every process on the machine, so any local process — not just the
 * user running Studio — can read the secrets in the clear. This defeats the
 * whole point of `../credentials/mcpServerSecretStore.ts` encrypting those
 * same values at rest.
 *
 * The fix: serialise the config to a file created with mode 0600 AT OPEN
 * TIME (the `mode` passed to `writeFileSync`'s underlying `open()` call, not
 * a `chmodSync` applied after a default-mode create — a create-then-chmod
 * sequence has a window where the file is briefly world/group-readable, and
 * that window is exactly when another local process could read it), inside
 * a fresh 0700 directory, and pass `--mcp-config <path>` instead. The CLI
 * runs as the same OS user and reads the path itself; nothing else on the
 * machine can list the directory or open the file. One directory per TURN —
 * mirrors `claudeCliAttachments.ts`'s staging discipline exactly (`os.tmpdir()`,
 * never `studio-workspace/**`, since every path under that root is git-tracked
 * and this is turn-scoped working data, not project content) — created here,
 * deleted by the driver's own `finally` block regardless of how the turn
 * ends (success, error, or the subprocess being killed on abort).
 */
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MCP_CONFIG_DIR_PREFIX = 'studio-claude-cli-mcp-config-'
const MCP_CONFIG_DIR_MODE = 0o700
const MCP_CONFIG_FILE_MODE = 0o600
const MCP_CONFIG_FILE_NAME = 'mcp-config.json'

export interface McpConfigFile {
  /** The turn-scoped directory holding just this one file — removed wholesale on cleanup. */
  readonly dir: string
  /** Absolute path to pass as `--mcp-config <path>`. */
  readonly path: string
}

/**
 * Serialise `config` to a fresh, private temp file and return its path.
 * Throws if the directory or file cannot be created — the caller
 * (`streamClaudeCli`) treats that as a soft failure, the same "continue
 * without tools" posture a connector-mint failure already gets, never a
 * reason to fail the whole turn.
 */
export function writeMcpConfigFile(config: unknown): McpConfigFile {
  const dir = mkdtempSync(join(tmpdir(), MCP_CONFIG_DIR_PREFIX))
  try {
    chmodSync(dir, MCP_CONFIG_DIR_MODE)
  } catch {
    // Best-effort on platforms without POSIX mode bits (Windows) — same
    // posture claudeCliAttachments.ts's staging directory already takes.
  }

  const path = join(dir, MCP_CONFIG_FILE_NAME)
  // `mode` here is the create-time permission — the file never exists with
  // any wider mode, not even for an instant. The redundant chmodSync below
  // only matters if a future caller ever reused an existing path (this one
  // never does, since `dir` is freshly minted above), kept for parity with
  // `mcpServerSecretStore.ts`'s identical belt-and-braces.
  writeFileSync(path, JSON.stringify(config), { mode: MCP_CONFIG_FILE_MODE })
  try {
    chmodSync(path, MCP_CONFIG_FILE_MODE)
  } catch {
    // Best-effort — see above.
  }
  return { dir, path }
}

/**
 * Delete the turn-scoped directory (and the config file inside it)
 * unconditionally — called from the driver's `finally` block on every exit
 * path: a normal result, an error, or the subprocess being killed on abort.
 * Never throws: a failed cleanup must not turn into a turn-level error, and
 * the directory is gone from `os.tmpdir()` on the next reboot regardless.
 */
export function cleanupMcpConfigFile(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    console.error('[ai/claudeCli] failed to clean up the MCP config file — continuing:', err)
  }
}
