/**
 * figmaUrl — the one parser for a Figma URL, and the one scanner that finds
 * one inside free text.
 *
 * ## Why it is its own leaf
 *
 * A Figma link arrives on three unrelated paths and every one of them needs
 * the same two numbers out of it:
 *
 *   - a design system's `figma.connect(Component, url, …)` call site
 *     (`figmaCodeConnect.ts`, which is where this parser originally lived);
 *   - the user's chat message, scanned once per turn to build the live digest
 *     (`server/ai/tools/studio/liveDigest.ts`) so the prompt can name the file
 *     key and node id instead of saying "there is a Figma link in here
 *     somewhere";
 *   - the `url` argument of `studio_import_figma_frame`, which records it as
 *     the reference's provenance and hands the node id back to the agent to
 *     feed its own Figma connector.
 *
 * Three copies of a regex that answers "which node does this URL point at"
 * is exactly the drift this repo's SSOT rule exists to prevent, so the
 * parser lives here with no dependencies at all — not even TypeBox. It is a
 * pure string function.
 *
 * ## What it deliberately does NOT do
 *
 * It never fetches anything. Studio's server has no Figma connection and
 * will not grow one (see `designVariableTools.ts`'s module doc): a parsed
 * `{ fileKey, nodeId }` is a pair of identifiers for the AGENT to pass to
 * ITS own Figma connector, never something this process resolves.
 */

/**
 * Every URL shape Figma actually serves a file under. `design` is today's
 * canonical one; `file` is the pre-2023 spelling still pasted from old links
 * and bookmarks; `proto` is a prototype share link; `board` is FigJam. All
 * four carry the same base62 file key in the same position, so refusing the
 * other three would reject a link that names exactly the node the user meant.
 */
const FIGMA_FILE_KEY_RE = /figma\.com\/(?:design|file|proto|board)\/([A-Za-z0-9]+)/

const FIGMA_NODE_ID_QUERY_RE = /[?&]node-id=([^&#]+)/

/**
 * A real Figma node id as it appears in a URL query param: digits, a
 * separator, digits. Figma writes the separator as `-` in a copied link and
 * as `%3A` (a colon) in an older or API-shaped one; both decode to the same
 * node. Anything else — a `figma connect create` scaffold's un-filled-in
 * `REPLACE-ME`, or any other non-numeric placeholder a future template might
 * use — is flagged via `nodeIdPlaceholder` rather than silently treated as a
 * resolvable reference.
 */
const FIGMA_NODE_ID_SHAPE_RE = /^(\d+)[-:](\d+)$/

/** A figma.com URL anywhere in free text. Deliberately greedy on the path (`\S+`) — `trimUrlPunctuation` below undoes the over-capture that costs. */
const FIGMA_URL_IN_TEXT_RE = /https?:\/\/(?:www\.)?figma\.com\/\S+/i

export interface ParsedFigmaUrl {
  /** The base62 file key — the `fileKey`/`file_key` argument every Figma API and MCP tool takes. `undefined` when the string is not a recognisable Figma file URL at all. */
  readonly fileKey: string | undefined
  /**
   * The node id in Figma's own canonical `123:456` form, whatever separator
   * the URL used. When `nodeIdPlaceholder` is true this is the raw,
   * un-normalised text instead (or `undefined` when the URL carried no
   * `node-id` at all) — a caller must check that flag before passing this to
   * a Figma tool.
   */
  readonly nodeId: string | undefined
  /** `true` when `nodeId` is not a resolvable Figma node reference: missing, or a non-numeric placeholder. */
  readonly nodeIdPlaceholder: boolean
}

/** Never throws — an unparseable string just yields every field `undefined` with `nodeIdPlaceholder: true`. */
export function parseFigmaUrl(url: string): ParsedFigmaUrl {
  const fileKeyMatch = FIGMA_FILE_KEY_RE.exec(url)
  const nodeIdMatch = FIGMA_NODE_ID_QUERY_RE.exec(url)

  let rawNodeId: string | undefined
  if (nodeIdMatch?.[1]) {
    try {
      rawNodeId = decodeURIComponent(nodeIdMatch[1])
    } catch {
      // A malformed percent-escape is still a node id the user typed; keep
      // the literal text rather than losing the whole parse to it.
      rawNodeId = nodeIdMatch[1]
    }
  }

  const shape = rawNodeId === undefined ? null : FIGMA_NODE_ID_SHAPE_RE.exec(rawNodeId)
  return {
    fileKey: fileKeyMatch?.[1],
    nodeId: shape ? `${shape[1]}:${shape[2]}` : rawNodeId,
    nodeIdPlaceholder: shape === null,
  }
}

/**
 * Trailing characters a URL picks up from the sentence around it. A pasted
 * link routinely ends a sentence ("…?node-id=1-2.") or sits inside brackets
 * or markdown, and `\S+` swallows all of it — which would corrupt the node
 * id, the one part of the URL a caller actually acts on.
 */
const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]}>"'`]+$/

function trimUrlPunctuation(url: string): string {
  return url.replace(TRAILING_PUNCTUATION_RE, '')
}

export interface FigmaUrlInText extends ParsedFigmaUrl {
  /** The URL exactly as it appeared in the text, minus trailing sentence punctuation. */
  readonly url: string
}

/**
 * The FIRST figma.com URL in a block of free text (a chat message), parsed.
 * `null` when there is none.
 *
 * First, not all of them: this feeds a single-page nudge, and a message
 * naming two designs is a question about which page each belongs to — not
 * something to guess at by picking one silently. A caller that needs the
 * others should say so and get its own function.
 */
export function findFigmaUrlInText(text: string): FigmaUrlInText | null {
  const match = FIGMA_URL_IN_TEXT_RE.exec(text)
  if (!match) return null
  const url = trimUrlPunctuation(match[0])
  return { url, ...parseFigmaUrl(url) }
}
