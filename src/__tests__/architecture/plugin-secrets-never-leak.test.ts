/**
 * Architecture gate — plugin secret material never crosses the HTTP
 * boundary. Modelled on `ai-credentials-never-leak.test.ts`.
 *
 * Static scan of `server/handlers/**` (every HTTP-handler module):
 *
 *   - Handler files must not read `.ciphertext` / `.iv` — there is no
 *     legitimate handler reason to touch raw encryption material from
 *     `plugin_secrets` rows. `RAW_MATERIAL_ALLOWLIST` names the files under
 *     this directory that are credential REPOSITORIES rather than handlers,
 *     each with a §-numbered justification and its own no-leak test.
 *
 *   - Handler files must not import `resolvePluginSecretsForRuntime` — the
 *     decrypted-plaintext projection is reserved for the server-side
 *     runtime path (`server/plugins/settingsCache.ts` seeds the QuickJS
 *     worker mirror and the `settings.changed` hook payload). Handlers
 *     reach the runtime record only through `refreshPluginSettingsCache`,
 *     whose return value feeds the worker — never a response body.
 *
 *   - The browser-bound presentation goes through `projectSecretSettings` /
 *     `listPluginSecretStates`, which only expose presence (`'***'` / `''`)
 *     and the per-field key-fingerprint state.
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, extname, relative } from 'path'

const REPO_ROOT = join(import.meta.dir, '../../../')
const HANDLERS_DIR = join(REPO_ROOT, 'server/handlers')

/** The only module allowed to import the plaintext runtime projection. */
const RUNTIME_RESOLUTION_ALLOWLIST = new Set([
  'server/plugins/settingsCache.ts',
])

/**
 * Files under `server/handlers/**` that are CREDENTIAL REPOSITORIES rather
 * than HTTP handlers, and therefore legitimately hold `ciphertext`/`iv`.
 *
 * The scan's directory is an over-approximation of "HTTP handler": Studio's
 * server half is organised by feature under `server/handlers/studio/`, so a
 * feature's own repository lives beside its routes. The rule this gate
 * actually protects — encryption material never reaches a response body — is
 * preserved for each entry by a wire-shape that has no such field, plus a test
 * that asserts it.
 *
 * §1  githubCredentialStore.ts — the `git_credentials` table (G2). It is the
 *     only module that encrypts, decrypts, or deletes a user's GitHub token;
 *     the shape it hands the route (`GithubAccountView`) carries login,
 *     avatar, scopes, and expiry and NOTHING else, and
 *     `server/handlers/__tests__/githubAuth.test.ts` asserts that no response
 *     body from any `/admin/api/studio/github/*` route contains the token.
 */
const RAW_MATERIAL_ALLOWLIST = new Set([
  'server/handlers/studio/githubCredentialStore.ts',
])

function listFilesRecursive(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...listFilesRecursive(full))
    else if (extname(full) === '.ts') out.push(full)
  }
  return out
}

describe('plugin-secrets-never-leak gate', () => {
  it('no HTTP handler file touches raw encryption material or the plaintext runtime projection', () => {
    const files = listFilesRecursive(HANDLERS_DIR)
    expect(files.length).toBeGreaterThan(0)

    const violations: { file: string; finding: string }[] = []

    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      const rel = relative(REPO_ROOT, file).replaceAll('\\', '/')

      const rawMaterialAllowed = RAW_MATERIAL_ALLOWLIST.has(rel)
      const PATTERNS: Array<{ name: string; re: RegExp }> = [
        ...(rawMaterialAllowed
          ? []
          : ([
              { name: '.ciphertext member access', re: /\.ciphertext\b/ },
              // `\.iv\b` is too noisy (matches `.invoke` etc.). Require an
              // ASCII boundary specifically after the `iv` field.
              { name: '.iv member access', re: /\.iv(?=[\s,;)\]}.])/ },
            ] as Array<{ name: string; re: RegExp }>)),
        { name: 'import of resolvePluginSecretsForRuntime (plaintext projection)', re: /resolvePluginSecretsForRuntime/ },
      ]

      for (const pattern of PATTERNS) {
        if (pattern.re.test(src)) {
          violations.push({ file: rel, finding: pattern.name })
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `[plugin-secrets-never-leak] handler files touch plugin secret material:\n` +
        violations.map((v) => `  ${v.file} → ${v.finding}`).join('\n') +
        `\n\nProject plugin_secrets rows through listPluginSecretStates() / projectSecretSettings() before serialising.`,
      )
    }
    expect(violations).toHaveLength(0)
  })

  it('resolvePluginSecretsForRuntime is imported only by the sanctioned runtime modules', () => {
    const serverFiles = listFilesRecursive(join(REPO_ROOT, 'server'))
    const offenders: string[] = []
    for (const file of serverFiles) {
      const rel = relative(REPO_ROOT, file).replaceAll('\\', '/')
      if (rel === 'server/repositories/pluginSecrets.ts') continue // declaration site
      const src = readFileSync(file, 'utf8')
      // Match actual imports/usages, not doc-comment mentions: an import
      // clause or a call site.
      const imports = /import\s*\{[^}]*\bresolvePluginSecretsForRuntime\b[^}]*\}/.test(src)
      const calls = /\bresolvePluginSecretsForRuntime\s*\(/.test(src)
      if ((imports || calls) && !RUNTIME_RESOLUTION_ALLOWLIST.has(rel)) {
        offenders.push(rel)
      }
    }
    expect(offenders).toEqual([])
  })

  it('plugin handler responses funnel through the wire-safe secret projection', () => {
    const sharedSrc = readFileSync(
      join(REPO_ROOT, 'server/handlers/cms/plugins/shared.ts'),
      'utf8',
    )
    const settingsSrc = readFileSync(
      join(REPO_ROOT, 'server/handlers/cms/plugins/settings.ts'),
      'utf8',
    )
    expect(sharedSrc.includes('listPluginSecretStates(')).toBe(true)
    expect(sharedSrc.includes('projectSecretSettings(')).toBe(true)
    expect(settingsSrc.includes('projectSecretSettings(')).toBe(true)
  })
})
