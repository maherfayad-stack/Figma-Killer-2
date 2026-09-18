/**
 * Architecture gate — AI driver SDK isolation.
 *
 * The rule (WS-11 §6.1): **no provider SDK may be imported; a driver may
 * reach its provider over HTTP/SSE or via a local user-installed binary.**
 * Every HTTP driver talks DIRECTLY to its provider's REST API — there are no
 * provider SDKs left in the tree for those. `claudeCli`
 * (`server/ai/drivers/claudeCli.ts`) is the one exception to "HTTP/SSE": it
 * spawns the `claude` binary the user installed themselves, the same way the
 * Claude Code VS Code extension does — that is still not an SDK import (no
 * new dependency, nothing added to `bun.lock`), so it doesn't relax what this
 * gate actually checks below, only the doc comment's original (narrower)
 * phrasing of the rule. This gate asserts that NO provider SDK and NO `zod`
 * is imported ANYWHERE under `src/` or `server/` (a strictly stronger
 * boundary than the old "only the driver file may import it" exemption).
 *
 * This replaces the legacy `no-anthropic-sdk.test.ts` gate, which only
 * scanned `src/` and predates the `server/ai/` module. The legacy gate
 * remains in place for the editor (the browser must never import any AI
 * SDK); this gate covers the server side too.
 *
 * Banned repo-wide (no allowed callers):
 *   - `@anthropic-ai/claude-agent-sdk` — replaced by direct POST /v1/messages
 *   - `@openai/agents`                  — replaced by direct POST /v1/responses
 *   - `@openrouter/agent`               — replaced by direct POST /v1/responses
 *   - `zod`                             — drivers pass TypeBox schemas through
 *                                         as JSON Schema; no Zod bridge
 *   - `@anthropic-ai/sdk`               — the plain SDK, always banned
 *
 * Scoped (allowed under one prefix only):
 *   - `@modelcontextprotocol/sdk`       — allowed ONLY under `server/ai/mcp/`,
 *                                         where Studio implements an MCP
 *                                         *server* (a real wire protocol — a
 *                                         legitimate SDK use). Still banned in
 *                                         the drivers and the browser, which
 *                                         must never speak MCP.
 */

import { describe, it, expect } from 'bun:test'
import { join } from 'path'
import { REPO_ROOT, readSource, toRepoRelativePosix, walkSourceTree } from './helpers/sourceTree'

const SCAN_DIRS = ['src', 'server']
const SCAN_EXTENSIONS = ['.ts', '.tsx', '.js', '.mts', '.mjs']

interface PackageRule {
  /** Display name in error messages. */
  label: string
  /** Regex matched against the file's content. */
  importRe: RegExp
  /**
   * Repo-relative file paths (forward slashes) that may import this
   * package. Anything outside this list violates the gate.
   */
  allowed: string[]
  /**
   * Repo-relative path prefixes (forward slashes) under which this package
   * may be imported by any file. Used for module-scoped allowances (e.g. the
   * MCP server lives under `server/ai/mcp/` and owns the MCP SDK).
   */
  allowedPrefixes?: string[]
}

const RULES: PackageRule[] = [
  {
    label: '@anthropic-ai/claude-agent-sdk',
    importRe: /from\s+['"]@anthropic-ai\/claude-agent-sdk['"]|require\s*\(\s*['"]@anthropic-ai\/claude-agent-sdk['"]\s*\)/,
    // No allowed callers — replaced by the direct /v1/messages HTTP driver.
    allowed: [],
  },
  {
    label: '@openai/agents',
    importRe: /from\s+['"]@openai\/agents['"]|require\s*\(\s*['"]@openai\/agents['"]\s*\)/,
    // No allowed callers — replaced by the direct /v1/responses HTTP driver.
    allowed: [],
  },
  {
    label: '@openrouter/agent',
    importRe: /from\s+['"]@openrouter\/agent['"]|require\s*\(\s*['"]@openrouter\/agent['"]\s*\)/,
    // No allowed callers — replaced by the direct /v1/responses HTTP driver.
    allowed: [],
  },
  {
    label: '@modelcontextprotocol/sdk',
    importRe: /from\s+['"]@modelcontextprotocol\/sdk['"]|require\s*\(\s*['"]@modelcontextprotocol\/sdk['"]\s*\)|from\s+['"]@modelcontextprotocol\/sdk\/|require\s*\(\s*['"]@modelcontextprotocol\/sdk\//,
    // Allowed only inside the MCP server module — banned everywhere else.
    allowed: [],
    allowedPrefixes: ['server/ai/mcp/'],
  },
  {
    label: 'zod',
    importRe: /from\s+['"]zod['"]|require\s*\(\s*['"]zod['"]\s*\)/,
    // No allowed callers — drivers pass TypeBox schemas through as JSON Schema.
    allowed: [],
  },
  {
    label: '@anthropic-ai/sdk',
    importRe: /from\s+['"]@anthropic-ai\/sdk['"]|require\s*\(\s*['"]@anthropic-ai\/sdk['"]\s*\)/,
    // No allowed callers — the plain Anthropic SDK is banned repo-wide.
    allowed: [],
  },
]

describe('ai-driver-isolation gate', () => {
  // One shared walk, read in parallel (`helpers/sourceTree.ts`). This gate used
  // to re-read all of `src/` + `server/` once per RULE with a serial
  // `readFileSync`, which cost 29.7 s against its own 20 s per-test budget.
  //
  // The architecture-gate exclusion below was `full.includes('/__tests__/architecture/')`,
  // which on win32 matched NOTHING (the walked path carried backslashes), so on
  // Windows this gate scanned its own rule literals. It never produced a false
  // positive only because those literals are regex source, not import syntax —
  // an accident, not a design. Comparing a POSIX-normalised relative path is
  // what makes the exclusion mean the same thing on both platforms.
  const allFiles = SCAN_DIRS.flatMap((d) => walkSourceTree(join(REPO_ROOT, d), SCAN_EXTENSIONS)).filter(
    (full) => !toRepoRelativePosix(full).includes('/__tests__/architecture/'),
  )

  for (const rule of RULES) {
    it(`${rule.label}: only allowed files import it`, () => {
      const violations: string[] = []
      for (const file of allFiles) {
        const rel = toRepoRelativePosix(file)
        if (rule.allowed.includes(rel)) continue
        if (rule.allowedPrefixes?.some((p) => rel.startsWith(p))) continue
        if (rule.importRe.test(readSource(file))) {
          violations.push(rel)
        }
      }
      if (violations.length > 0) {
        throw new Error(
          `[ai-driver-isolation] ${rule.label} imported from disallowed locations:\n` +
          violations.map((v) => `  ${v}`).join('\n') +
          `\n\nAllowed: ${rule.allowed.length === 0 ? '<none — package is banned repo-wide>' : rule.allowed.join(', ')}`,
        )
      }
      expect(violations).toHaveLength(0)
    })
  }
})
