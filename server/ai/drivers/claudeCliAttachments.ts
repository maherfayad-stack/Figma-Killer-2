/**
 * claudeCliAttachments — WS-12 §5.3: images and files, staged to disk and
 * passed to the CLI BY PATH rather than inlined into the prompt.
 *
 * Why path-based, for images too, even though "images already work" for
 * every HTTP driver as inline base64 content blocks: `--input-format
 * stream-json` (the only mechanism that could carry an inline multimodal
 * payload into `-p` mode) has an unverified stdin message shape — WS-11's
 * own documented reason for never using it (`claudeCli.ts`'s "Multi-turn
 * continuity" doc comment). There is no confirmed `-p` flag for inline image
 * bytes either (checked against `--help`). Staging to a file and pointing at
 * it by absolute path is the one mechanism this driver can use with
 * confidence: the CLI's own built-in tools (Read, at minimum — the
 * top-level session is never `--tools`-restricted, unlike the generated
 * subagents) read the file themselves.
 *
 * One directory per TURN, not per session — created fresh, torn down in the
 * driver's own `finally` block alongside connector revocation. `os.tmpdir()`,
 * never inside `studio-workspace/` — an attachment is turn-scoped working
 * data, not project content, and does not belong committed to the user's repo.
 */
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AiContentBlock } from '../runtime/types'

const ATTACHMENTS_DIR_PREFIX = 'studio-claude-cli-attachments-'
const STAGING_MODE = 0o700

/** Sniffed-safe extension per declared mime type — never trust a client-declared filename (there isn't one here at all; this is server-derived). */
const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

export interface StagedAttachment {
  readonly path: string
  readonly mimeType: string
}

export interface AttachmentStaging {
  readonly dir: string
  readonly files: readonly StagedAttachment[]
}

/**
 * Stages every image block in `content` to its own file inside a fresh temp
 * directory. Returns `null` when there is nothing to stage (no directory is
 * created at all in that case — a turn with no attachments costs nothing).
 * Never throws: a single bad block is skipped, not fatal to the whole turn.
 */
export function stageAttachments(content: readonly AiContentBlock[]): AttachmentStaging | null {
  const imageBlocks = content.filter(
    (b): b is Extract<AiContentBlock, { kind: 'image' }> => b.kind === 'image',
  )
  if (imageBlocks.length === 0) return null

  const dir = mkdtempSync(join(tmpdir(), ATTACHMENTS_DIR_PREFIX))
  try {
    chmodSync(dir, STAGING_MODE)
  } catch {
    // Best-effort on platforms without POSIX mode bits (Windows) — same
    // posture claudeCliEnv.ts's config dir already takes.
  }

  const files: StagedAttachment[] = []
  let index = 0
  for (const block of imageBlocks) {
    index += 1
    const ext = EXTENSION_BY_MIME[block.mimeType] ?? ''
    const path = join(dir, `attachment-${index}${ext}`)
    try {
      writeFileSync(path, Buffer.from(block.data, 'base64'))
      files.push({ path, mimeType: block.mimeType })
    } catch (err) {
      console.error('[ai/claudeCli] failed to stage an attachment, skipping it:', err)
    }
  }

  if (files.length === 0) {
    cleanupAttachments(dir)
    return null
  }
  return { dir, files }
}

/** Torn down unconditionally at the end of every turn that staged one — never left behind. */
export function cleanupAttachments(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    console.error('[ai/claudeCli] failed to clean up a staged attachment directory:', err)
  }
}

/** The line appended to the `-p` prompt naming every staged file by absolute path — the model reads them with its own tools. */
export function describeAttachmentsForPrompt(staging: AttachmentStaging): string {
  const paths = staging.files.map((f) => f.path).join(', ')
  return `\n\nAttached image file(s), read them with your own file tools before answering: ${paths}`
}
