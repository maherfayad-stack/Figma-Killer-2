/**
 * readProjectImageBytes — read an image the agent already downloaded INTO the
 * project, with the containment check and the one refusal message that is
 * worth answering rather than merely blocking.
 *
 * Its own module because two tools need the identical read:
 * `studio_register_design_reference` (`designReferenceTools.ts`, where this
 * lived first) and `studio_import_figma_frame` (`importFigmaFrame.ts`), which
 * is the same read one layer up. A second copy would drift on the part that
 * matters least visibly and most — whether containment is asserted on the
 * REAL path or the lexical one.
 */
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { DESIGN_REFERENCE_MAX_BYTES } from '@core/ai'
import { assertPathWithin } from '../../../../util/pathWithin'
import { listDesignReferences } from '../../../../handlers/studio/designReferenceStore'
import { CHAT_ATTACHMENT_REFERENCE_SOURCE } from '../../../../handlers/studio/designReferenceSchema'

/**
 * The refusal for a path outside the project — which, in practice, is almost
 * always ONE specific mistake worth answering rather than merely blocking.
 *
 * An image the user attaches to chat is staged by the driver to an
 * `os.tmpdir()` directory (`claudeCliAttachments.ts` — turn-scoped working
 * data, deliberately not project content) and its absolute path is handed to
 * the model in the prompt. The very same bytes were ALREADY registered as a
 * durable reference before the turn started (`registerTurnDesignReferences`).
 * So the model reads the one path it was given, tries to register it, and is
 * told it is outside the project — a correct policy answer to a question that
 * did not need asking, and the third-most-common wasted tool call in a turn
 * that begins with a pasted design.
 *
 * When a chat-attached reference exists, say so and name its id. Containment
 * is unchanged: nothing outside the project is read, opened, or hashed here —
 * the manifest that answers the question is already inside it.
 */
export function outsideProjectMessage(dir: string, filePath: string): string {
  const attached = listDesignReferences(dir, undefined, undefined).references.filter(
    (r) => r.source === CHAT_ATTACHMENT_REFERENCE_SOURCE,
  )
  const base = `"${filePath}" resolves outside this project. A design reference must be read from a file inside the project directory.`
  if (attached.length === 0) return base

  const newest = attached[attached.length - 1]!
  return (
    `${base} If this is the image attached to this conversation, you do not need to register it — ` +
    `an attached image is registered automatically before the turn starts. It is already stored as ` +
    `"${newest.id}"${newest.pageId ? ` (page "${newest.pageId}")` : ''}, ${newest.width}x${newest.height}, ` +
    `with role "context" (an attachment is kept, but is never assumed to be the design to match). ` +
    `Measure against it by passing referenceId:"${newest.id}" to studio_compare, rather than registering it again.`
  )
}

/**
 * Read an image the agent already downloaded into the project.
 *
 * This is the route that actually closes the Figma loop. The in-canvas agent
 * runs as a Claude CLI subprocess whose MCP servers include the user's own
 * Figma connector, and an image that connector renders INLINE is a picture the
 * model can see but cannot re-emit as bytes — there is no path from it into
 * `imageBase64`. Its asset-DOWNLOAD tool writes real files to disk instead,
 * and the subprocess's cwd is the project, so the file is already somewhere
 * this function can reach. Without this input the agent's only remaining
 * option was to ask the user to attach the PNG by hand.
 *
 * Containment is asserted on the REAL paths, after `realpath`, not on the
 * lexical join: a project can legitimately contain symlinks (`node_modules`
 * most obviously), so a lexically-contained path can still resolve outside the
 * project. An absolute input is accepted rather than rejected — the CLI's cwd
 * is the project root, so its tools naturally hand back absolute paths — but
 * it is subject to exactly the same containment check.
 */
export type ReadProjectImageResult = { ok: true; bytes: Uint8Array } | { ok: false; error: string }

export async function readProjectImageBytes(
  dir: string,
  filePath: string,
): Promise<ReadProjectImageResult> {
  const candidate = isAbsolute(filePath) ? filePath : resolvePath(dir, filePath)

  let realRoot: string
  let realTarget: string
  try {
    realRoot = await realpath(dir)
    realTarget = await realpath(candidate)
  } catch {
    return { ok: false, error: `No file at "${filePath}" inside this project. Download the export first, then pass the path it was written to.` }
  }

  try {
    assertPathWithin(realRoot, realTarget)
  } catch {
    return { ok: false, error: outsideProjectMessage(dir, filePath) }
  }

  const info = await stat(realTarget)
  if (!info.isFile()) return { ok: false, error: `"${filePath}" is not a file.` }
  if (info.size > DESIGN_REFERENCE_MAX_BYTES) {
    return {
      ok: false,
      error: `"${filePath}" is ${info.size} bytes, over the ${DESIGN_REFERENCE_MAX_BYTES}-byte design-reference limit.`,
    }
  }

  return { ok: true, bytes: new Uint8Array(await readFile(realTarget)) }
}

