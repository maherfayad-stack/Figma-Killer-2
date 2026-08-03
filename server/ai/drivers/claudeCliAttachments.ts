/**
 * claudeCliAttachments — WS-12 §5.3: images AND files, staged to disk and
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
 * confidence: the CLI's own built-in `Read` tool reads the file itself.
 * `Read` is the one native built-in `claudeCli.ts` grants — via `--tools`,
 * and only on a turn that actually staged something here — precisely
 * because this is its load-bearing use; see that file's doc comment
 * ("Native tool surface", sec-XX) for the full reasoning and why every
 * other native tool stays withheld.
 *
 * **Files reuse the existing `kind: 'image'` content block, deliberately —
 * no new `AiContentBlock` kind.** That was an explicit decision, not this
 * module's own shortcut: `AiImageBlockSchema.mimeType` is already an
 * unconstrained string, so a text-ish mime type (`text/markdown`,
 * `application/json`, ...) already fits the wire shape without touching a
 * schema every driver/persistence consumer shares. This module is what
 * decides which mime types are "an image" vs. "a staged text-ish file" vs.
 * refused outright — provider-specific by construction, exactly matching
 * how a person hands the CLI a file today (a path, not inline bytes).
 *
 * A binary blob the model cannot usefully read as text is a cost with no
 * benefit — refused with a reason (surfaced in the prompt, since a staging
 * refusal has no tool-call id to attach an error to), never silently
 * staged and never silently dropped.
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

/** Decoded-byte cap for a text-ish file — generous for a spec/README/token export, bounded so a mislabeled large payload can't blow up a turn. Images have no separate cap here — they're already bounded upstream by `AI_USER_IMAGE_MAX_BASE64_CHARS` before this module ever sees them. */
const FILE_MAX_BYTES = 256 * 1024

const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

/** The explicit allow-list — "source, markdown, JSON, CSV, plain text" — never a catch-all. */
const FILE_EXTENSION_BY_MIME: Record<string, string> = {
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/json': '.json',
  'text/csv': '.csv',
  'text/css': '.css',
  'text/html': '.html',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'text/javascript': '.js',
  'application/javascript': '.js',
  'text/typescript': '.ts',
  'application/typescript': '.ts',
  'text/x-python': '.py',
  'text/yaml': '.yaml',
  'application/yaml': '.yaml',
}

export interface StagedAttachment {
  readonly path: string
  readonly mimeType: string
  readonly kind: 'image' | 'file'
}

export interface RefusedAttachment {
  readonly mimeType: string
  readonly reason: string
}

export interface AttachmentStaging {
  readonly dir: string
  readonly files: readonly StagedAttachment[]
  readonly refused: readonly RefusedAttachment[]
}

/**
 * Stages every eligible `kind: 'image'` block in `content` to its own file
 * inside a fresh temp directory — an actual image (by mime type), or a
 * text-ish file within the explicit allow-list and size cap. Returns `null`
 * only when there is NOTHING to report at all (no blocks staged, none
 * refused) — a turn with no attachments costs nothing. A block that IS
 * refused still produces a non-null result (with an empty `files` array if
 * nothing else staged), so the refusal reaches the prompt. Never throws: a
 * single bad block is skipped, not fatal to the whole turn.
 */
export function stageAttachments(content: readonly AiContentBlock[]): AttachmentStaging | null {
  const candidateBlocks = content.filter(
    (b): b is Extract<AiContentBlock, { kind: 'image' }> => b.kind === 'image',
  )
  if (candidateBlocks.length === 0) return null

  const files: StagedAttachment[] = []
  const refused: RefusedAttachment[] = []
  let dir: string | null = null
  let index = 0

  for (const block of candidateBlocks) {
    index += 1
    const imageExt = IMAGE_EXTENSION_BY_MIME[block.mimeType]
    const fileExt = FILE_EXTENSION_BY_MIME[block.mimeType]

    if (!imageExt && !fileExt) {
      refused.push({ mimeType: block.mimeType, reason: `unsupported type "${block.mimeType}" — not an image and not in the allow-list (plain text, markdown, JSON, CSV, common source types)` })
      continue
    }

    let bytes: Buffer
    try {
      bytes = Buffer.from(block.data, 'base64')
    } catch {
      refused.push({ mimeType: block.mimeType, reason: 'could not decode base64 data' })
      continue
    }

    if (fileExt && bytes.byteLength > FILE_MAX_BYTES) {
      refused.push({ mimeType: block.mimeType, reason: `exceeds the ${FILE_MAX_BYTES.toLocaleString('en-US')}-byte staged-file limit (${bytes.byteLength.toLocaleString('en-US')} bytes)` })
      continue
    }

    if (!dir) {
      dir = mkdtempSync(join(tmpdir(), ATTACHMENTS_DIR_PREFIX))
      try {
        chmodSync(dir, STAGING_MODE)
      } catch {
        // Best-effort on platforms without POSIX mode bits (Windows) — same
        // posture claudeCliEnv.ts's config dir already takes.
      }
    }

    const ext = imageExt ?? fileExt
    const path = join(dir, `attachment-${index}${ext}`)
    try {
      writeFileSync(path, bytes)
      files.push({ path, mimeType: block.mimeType, kind: imageExt ? 'image' : 'file' })
    } catch (err) {
      console.error('[ai/claudeCli] failed to stage an attachment, skipping it:', err)
      refused.push({ mimeType: block.mimeType, reason: 'failed to write to the staging directory' })
    }
  }

  if (files.length === 0) {
    if (dir) cleanupAttachments(dir)
    return refused.length > 0 ? { dir: '', files: [], refused } : null
  }
  return { dir: dir!, files, refused }
}

/** Torn down unconditionally at the end of every turn that staged one — never left behind. A no-op for a refusal-only result (`dir === ''`, nothing was ever created). */
export function cleanupAttachments(dir: string): void {
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    console.error('[ai/claudeCli] failed to clean up a staged attachment directory:', err)
  }
}

/** The line(s) appended to the `-p` prompt naming every staged file by absolute path, plus any refusals — the model reads staged files with its own tools and can narrate a refusal to the user rather than the file just silently vanishing. */
export function describeAttachmentsForPrompt(staging: AttachmentStaging): string {
  const lines: string[] = []
  if (staging.files.length > 0) {
    const images = staging.files.filter((f) => f.kind === 'image').map((f) => f.path)
    const otherFiles = staging.files.filter((f) => f.kind === 'file').map((f) => f.path)
    if (images.length > 0) lines.push(`Attached image file(s), read them with your own file tools before answering: ${images.join(', ')}`)
    if (otherFiles.length > 0) lines.push(`Attached file(s), read them with your own file tools before answering: ${otherFiles.join(', ')}`)
  }
  if (staging.refused.length > 0) {
    const reasons = staging.refused.map((r) => `${r.mimeType} (${r.reason})`).join('; ')
    lines.push(`${staging.refused.length} attachment(s) could not be staged and were NOT sent — say so to the user rather than ignoring it: ${reasons}`)
  }
  return lines.length > 0 ? `\n\n${lines.join('\n')}` : ''
}
