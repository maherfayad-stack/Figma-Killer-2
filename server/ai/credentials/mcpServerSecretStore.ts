/**
 * Encrypted secret storage for Studio-registered project MCP servers.
 *
 * A registered server's NON-secret shape (name, transport, command/args/url,
 * non-secret env/headers, and which field names are secret) lives in
 * `.studio/meta.json` via `../drivers/registeredMcpServers.ts` — that file is
 * "Studio's state" in the same sense `approvedMcpServers` already is, and in
 * THIS repository's studio-workspace fixtures it is git-tracked. A secret
 * VALUE (a Figma/GitHub token, a bearer header, …) must never sit in that
 * file: committing `studio-workspace/**` (or a real end user's own project
 * repo) must never leak a credential.
 *
 * This module is the other half: it persists secret VALUES, encrypted with
 * the SAME AES-256-GCM master key and the SAME `encryptSecret`/`decryptSecret`
 * primitives `ai_provider_credentials` and `plugin_secrets` already use
 * (`server/secrets/encryption.ts` + `server/secrets/masterKey.ts`) — no
 * second crypto path. But it does NOT reuse either of those two tables:
 *
 *   - `ai_provider_credentials` is keyed by `(user_id, provider_id,
 *     display_label)` where `provider_id` is the closed `AiProviderId` union
 *     `server/ai/drivers/index.ts`'s `DRIVERS` record must map to an actual
 *     LLM driver — a project MCP server is not an LLM provider, and widening
 *     that union would force a fake driver entry and would surface these rows
 *     in the Settings → AI → Providers list, which is a real UX/security
 *     confusion bug, not just an abstraction wrinkle.
 *   - `plugin_secrets` is keyed by `(plugin_id, setting_id)` with a hard FK to
 *     `installed_plugins(id) on delete cascade` — a project MCP server has no
 *     plugin row to hang off.
 *
 * Adding a THIRD, correctly-shaped table (`user_id`, `project_key`,
 * `server_name`, `field_name`) is the honest fix, but this change ships
 * without a DB migration (another workstream owns migrations this round —
 * see STATE.md / the work order). CLAUDE.md's own architecture note for this
 * project — "Studio state belongs on disk, not in the database" — points at
 * the answer that needs no migration at all: persist the ciphertext as a
 * file under Studio's own per-user DATA ROOT, the exact pattern
 * `claudeCliEnv.ts`'s `resolveClaudeCliDataRoot()` already uses for another
 * reversible secret (the CLI's own OAuth `.credentials.json`) — `.data/` is
 * entirely git-ignored (see `.gitignore`), lives outside
 * `studio-workspace/**` (so it can never ride along with a project's own
 * repo), and outside any HTTP-served path.
 *
 * One JSON file per (user, project, server): `<dataRoot>/<userId>/<projectKey>/<serverName>.json`,
 * shaped `{ [fieldName]: { ciphertext, iv, keyFingerprint } }` (base64 —
 * JSON has no binary type). `keyFingerprint` mirrors the DB-backed stores: a
 * master-key rotation is detected and surfaced as "re-enter this secret"
 * rather than a silent decrypt failure.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { parseJsonWithFallback } from '@core/utils/jsonValidate'
import {
  decryptSecret,
  encryptSecret,
} from '../../secrets/encryption'
import { getMasterKeyFingerprint, loadMasterKey } from '../../secrets/masterKey'

const DEFAULT_DATA_ROOT_SEGMENT = ['.data', 'mcp-server-secrets'] as const
const FILE_MODE = 0o600
const DIR_MODE = 0o700

/** Resolve (without creating) the data root — overridable via env for ops flexibility, same convention as `resolveClaudeCliDataRoot`. */
export function resolveMcpServerSecretsRoot(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.MCP_SERVER_SECRETS_DATA_DIR
  return configured ? resolve(configured) : resolve(process.cwd(), ...DEFAULT_DATA_ROOT_SEGMENT)
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/

/**
 * Every path segment this module derives from caller-controlled strings
 * (`userId`, `projectKey`, `serverName`) is checked against this before it
 * ever reaches a filesystem call — this store has no other containment
 * mechanism (unlike `.studio/meta.json`, which lives inside an
 * already-validated project directory). Rejects empty, `..`, `/`, `\`, and
 * anything else that is not a plain identifier segment.
 */
function assertSafeSegment(value: string, what: string): void {
  // `SAFE_SEGMENT` allows `.` as a character (real project/server names can
  // contain one, e.g. `my.project`), which means a segment of EXACTLY `.` or
  // `..` would otherwise pass the character-class test while still being a
  // POSIX directory-traversal special case — checked explicitly, not folded
  // into the regex.
  if (value === '.' || value === '..' || !SAFE_SEGMENT.test(value)) {
    throw new Error(`[ai/mcpServerSecretStore] unsafe ${what} segment: ${JSON.stringify(value)}`)
  }
}

const SecretFileEntrySchema = Type.Object({
  ciphertext: Type.String(),
  iv: Type.String(),
  keyFingerprint: Type.String(),
})
const SecretFileSchema = Type.Record(Type.String(), SecretFileEntrySchema)
type SecretFile = Static<typeof SecretFileSchema>

function secretFilePath(root: string, userId: string, projectKey: string, serverName: string): string {
  assertSafeSegment(userId, 'userId')
  assertSafeSegment(projectKey, 'projectKey')
  assertSafeSegment(serverName, 'serverName')
  return join(root, userId, projectKey, `${serverName}.json`)
}

function readSecretFile(path: string): SecretFile {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, 'utf8')
  return parseJsonWithFallback(raw, SecretFileSchema, {})
}

function writeSecretFile(path: string, file: SecretFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
  try {
    chmodSync(dirname(path), DIR_MODE)
  } catch {
    // Best-effort on platforms without POSIX mode bits (Windows).
  }
  writeFileSync(path, JSON.stringify(file), { mode: FILE_MODE })
  try {
    chmodSync(path, FILE_MODE)
  } catch {
    // Best-effort — see above.
  }
}

/**
 * Encrypt and persist one secret field's value. Overwrites any previous
 * value for the same field. `plaintext` is never logged and never returned —
 * callers that need to confirm success read `hasMcpServerSecret` instead.
 */
export async function setMcpServerSecret(
  userId: string,
  projectKey: string,
  serverName: string,
  fieldName: string,
  plaintext: string,
  dataRoot: string = resolveMcpServerSecretsRoot(),
): Promise<void> {
  assertSafeSegment(fieldName, 'fieldName')
  const path = secretFilePath(dataRoot, userId, projectKey, serverName)
  const file = readSecretFile(path)
  const masterKey = await loadMasterKey()
  const encrypted = await encryptSecret(masterKey, plaintext)
  const fingerprint = await getMasterKeyFingerprint()
  file[fieldName] = {
    ciphertext: Buffer.from(encrypted.ciphertext).toString('base64'),
    iv: Buffer.from(encrypted.iv).toString('base64'),
    keyFingerprint: fingerprint,
  }
  writeSecretFile(path, file)
}

export class McpServerSecretKeyMismatchError extends Error {
  constructor(fieldName: string) {
    super(
      `[ai/mcpServerSecretStore] secret "${fieldName}" was encrypted with a different master key — re-enter it in Settings → AI → MCP Servers.`,
    )
    this.name = 'McpServerSecretKeyMismatchError'
  }
}

/**
 * Decrypt one secret field's value, or `null` if it was never set. Throws
 * `McpServerSecretKeyMismatchError` on a master-key rotation mismatch — the
 * caller (the merge path in `registeredMcpServers.ts`) treats that the same
 * as "missing": fail this one server soft, never the whole turn.
 */
export async function getMcpServerSecret(
  userId: string,
  projectKey: string,
  serverName: string,
  fieldName: string,
  dataRoot: string = resolveMcpServerSecretsRoot(),
): Promise<string | null> {
  const path = secretFilePath(dataRoot, userId, projectKey, serverName)
  const file = readSecretFile(path)
  const entry = file[fieldName]
  if (!entry) return null

  const currentFingerprint = await getMasterKeyFingerprint()
  if (entry.keyFingerprint !== currentFingerprint) {
    throw new McpServerSecretKeyMismatchError(fieldName)
  }

  const masterKey = await loadMasterKey()
  return decryptSecret(masterKey, {
    ciphertext: Buffer.from(entry.ciphertext, 'base64'),
    iv: Buffer.from(entry.iv, 'base64'),
  })
}

/** Whether a value is currently stored for this field — used by the approval UI to show "secret set" without ever decrypting it. */
export function hasMcpServerSecret(
  userId: string,
  projectKey: string,
  serverName: string,
  fieldName: string,
  dataRoot: string = resolveMcpServerSecretsRoot(),
): boolean {
  const path = secretFilePath(dataRoot, userId, projectKey, serverName)
  return fieldName in readSecretFile(path)
}

/**
 * Delete ONE stored field, leaving the server's other secrets intact — what
 * signing out of an OAuth session does (`mcpOAuthStore.ts`), as opposed to
 * removing the server itself. Removes the file entirely once its last field
 * is gone, so a signed-out server leaves no empty ciphertext envelope behind.
 * Never throws if the field or the file was never there.
 */
export function deleteMcpServerSecretField(
  userId: string,
  projectKey: string,
  serverName: string,
  fieldName: string,
  dataRoot: string = resolveMcpServerSecretsRoot(),
): void {
  assertSafeSegment(fieldName, 'fieldName')
  const path = secretFilePath(dataRoot, userId, projectKey, serverName)
  if (!existsSync(path)) return
  const file = readSecretFile(path)
  if (!(fieldName in file)) return
  delete file[fieldName]
  if (Object.keys(file).length === 0) rmSync(path)
  else writeSecretFile(path, file)
}

/** Delete every stored secret for one server — called when the server itself is removed from the registry, so no orphaned ciphertext lingers on disk. Never throws if nothing was stored. */
export function deleteMcpServerSecrets(
  userId: string,
  projectKey: string,
  serverName: string,
  dataRoot: string = resolveMcpServerSecretsRoot(),
): void {
  const path = secretFilePath(dataRoot, userId, projectKey, serverName)
  if (existsSync(path)) rmSync(path)
}
