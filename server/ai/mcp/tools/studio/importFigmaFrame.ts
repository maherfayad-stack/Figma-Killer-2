/**
 * `studio_import_figma_frame` — the whole "a Figma link arrived" ritual as
 * ONE call (W9-4).
 *
 * ## The ritual it replaces
 *
 * Before this, arming a page against a Figma frame took six tool calls in a
 * fixed order, and a weaker model got the ORDER wrong more often than it got
 * any single call wrong: download the export, `studio_register_design_
 * reference`, remember to pass `mode:'strict'`, `studio_ingest_design_
 * variables` scoped to the reference id that only exists after step 2,
 * `studio_list_pages` to find the frame, `studio_set_frames` to make the
 * board frame the design's own size. Miss the last one and every subsequent
 * `studio_compare` is graded on a RESAMPLED capture — an 800px-tall
 * reference against a 788px-tall frame — which is a weaker claim than the
 * strict threshold it is being measured with, silently.
 *
 * One call, one order, one place to state the defaults (`role:'spec'`,
 * `mode:'strict'`), and every leg reports its own status code so a failure
 * on one leg does not look like a failure of the whole import.
 *
 * ## Studio still never talks to Figma
 *
 * This tool fetches NOTHING. The Figma connector belongs to the AGENT (the
 * `claude` subprocess / the external MCP client), never to this server —
 * `designVariableTools.ts`'s module doc states the rule and it is unchanged
 * here. So every Figma-side input arrives as an argument the agent already
 * has in hand: an `exportPath` its connector's asset-download tool wrote to
 * disk, the `node` metadata JSON `get_metadata` returned, the `variables`
 * table `get_variable_defs` returned. **No token is accepted, stored,
 * logged, or returned by this tool, and `url` is recorded as provenance
 * text only.**
 *
 * ## Why `absoluteBoundingBox` is the load-bearing input
 *
 * It is the one number that removes an entire class of failure rather than
 * one instance of it. A board frame sized to the Figma frame's own box makes
 * `studio_export_frames`' capture land on the reference's pixel size without
 * a `dpr` search and without resampling — `studio_recommend_export_dpr`
 * exists precisely to work around NOT having this number, and its own doc
 * explains at length why a resampled comparison is the weaker claim.
 *
 * ## Section -> N screens
 *
 * A Figma SECTION (or a frame used as a board) holding sibling screen-sized
 * FRAMEs is N pages, not one. Detected mechanically (see
 * {@link detectScreens}) and ENUMERATED, never auto-created: creating N
 * Studio pages from one tool call would write files the user never asked
 * for, under names this tool would have to invent. The enumeration is what
 * the agent was missing; the `studio_create_page` calls after it are cheap
 * and already exist.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { resizeFrame, type Board, type BoardsFile } from '@core/studio-board'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { readProjectImageBytes } from './readProjectImageBytes'
import { DesignVariableEntrySchema, toRawDesignVariableEntries, type DesignVariableEntry } from './designVariableTools'
import { pushStudioLiveReload } from './liveReloadPush'
import { parseFigmaUrl } from '../../../../handlers/studio/figmaUrl'
import { registerDesignReference } from '../../../../handlers/studio/designReferenceStore'
import type { DesignReference } from '../../../../handlers/studio/designReferenceSchema'
import { ingestDesignVariables } from '../../../../handlers/studio/designVariableStore'
import { readBoardsFile, syncBoardFramesFromDisk, writeBoardsFile } from '../../../../handlers/studio/boardFrames'
import { FIDELITY_MODES, type FidelityMode } from '../../../../handlers/studio/fidelityMode'
import { MAX_VARIABLES_PER_INGEST } from '../../../../handlers/studio/designVariableSchema'

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * How many metadata nodes the traversal will visit before it stops and says
 * so. A whole Figma page's metadata is routinely tens of thousands of nodes;
 * everything this tool derives (the root box, the direct children, the
 * hidden-node tally) is answered long before that, so a cap costs nothing
 * real and keeps one pasted argument from pinning a CPU.
 */
const MAX_METADATA_NODES = 5_000

/** Hidden-node names reported back. A tally is the number that matters; the names are the sample that makes it actionable. */
const MAX_HIDDEN_NAMES = 20

/** Screens enumerated from one section. Beyond this the answer is "that is a whole file, not a section". */
const MAX_SCREENS = 40

/** Sanity bounds on a frame size derived from someone else's JSON. A 0-wide or 50000-wide board frame is a broken board, not a design. */
const MIN_FRAME_EDGE = 1
const MAX_FRAME_EDGE = 20_000

/** Below this a FRAME child is a component or a card, not a screen. Deliberately generous — the narrowest real device frame in Figma's own presets is 320px. */
const MIN_SCREEN_WIDTH = 240
const MIN_SCREEN_HEIGHT = 320

/**
 * A screen inside a section is nearly as tall as the section itself (screens
 * sit side by side); a hero or a header inside a SCREEN is a fraction of its
 * height (sections stack). This ratio is the whole discriminator, and it is
 * reported back as `screenDetection` so a wrong answer is inspectable rather
 * than mysterious.
 */
const SCREEN_HEIGHT_RATIO = 0.5

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const BoundingBoxSchema = Type.Object(
  {
    x: Type.Optional(Type.Number({ description: 'Left edge in Figma canvas coordinates. Ignored — a board frame is positioned by Studio, not by Figma.' })),
    y: Type.Optional(Type.Number({ description: 'Top edge in Figma canvas coordinates. Ignored, same reason as x.' })),
    width: Type.Number({ description: 'The frame\'s own width in px. THIS is the number that makes a comparison exact instead of resampled.' }),
    height: Type.Number({ description: 'The frame\'s own height in px.' }),
  },
  { additionalProperties: true },
)

/**
 * One node of Figma's metadata, as `get_metadata` returns it.
 *
 * `additionalProperties: true` at every level on purpose: the agent should
 * paste what its connector gave it, unedited. Asking a weaker model to strip
 * a Figma node down to five fields first is asking it to hand-transcribe
 * numbers, which is the single easiest place for it to introduce an error
 * this whole tool exists to remove. Only the named fields are ever read;
 * everything else is ignored, never stored, never echoed back.
 */
const FigmaNodeSchema = Type.Recursive(
  (Self) =>
    Type.Object(
      {
        id: Type.Optional(Type.String({ description: 'The Figma node id, e.g. "53958:5861".' })),
        name: Type.Optional(Type.String({ description: 'The layer name as it reads in Figma. Used for the hidden-node sample and the enumerated screen names.' })),
        type: Type.Optional(Type.String({ description: 'The Figma node type — FRAME, SECTION, COMPONENT, TEXT, and so on. Read to decide whether this node is a section of screens.' })),
        visible: Type.Optional(Type.Boolean({ description: 'Figma\'s own visibility flag. false means the layer is hidden in the design — this tool drops it and its whole subtree, and tells you how many it dropped, so you do not build something the designer turned off.' })),
        absoluteBoundingBox: Type.Optional(BoundingBoxSchema),
        children: Type.Optional(Type.Array(Self, { description: 'Child nodes, same shape.' })),
      },
      { additionalProperties: true },
    ),
  {
    $id: 'StudioFigmaMetadataNode',
    description:
      'The frame\'s metadata JSON exactly as your Figma connector returned it (get_metadata). Paste it UNEDITED — extra fields are ignored. absoluteBoundingBox is what sizes the board frame; visible:false subtrees are counted and reported so you do not build hidden layers; children are inspected to tell a single screen apart from a section of screens.',
  },
)

type FigmaNode = Static<typeof FigmaNodeSchema>

const ImportFigmaFrameInputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
    ),
    pageId: Type.String({
      minLength: 1,
      description: 'The Studio page this Figma frame is the design FOR (from studio_list_pages). Everything this tool does is scoped to it: the reference, the variable table, and the board frame that gets resized.',
    }),
    url: Type.Optional(
      Type.String({
        description: 'The Figma URL the user pasted. Recorded verbatim as the reference\'s provenance, and parsed for { fileKey, nodeId } which are echoed back in the result so you can pass them to your own Figma connector. Studio NEVER fetches this — it holds no Figma credential and will not accept one.',
      }),
    ),
    exportPath: Type.Optional(
      Type.String({
        description: 'Path to the exported PNG/JPEG your Figma connector already downloaded, inside this project (absolute or project-relative). Export at the frame\'s OWN pixel size — a 2x export against a 1x frame is the resample this tool exists to avoid. Omit it only if you genuinely have no export yet; without it no reference is registered and studio_compare still has nothing to measure against.',
      }),
    ),
    node: Type.Optional(FigmaNodeSchema),
    variables: Type.Optional(
      Type.Array(DesignVariableEntrySchema, {
        minItems: 1,
        maxItems: MAX_VARIABLES_PER_INGEST,
        description: `The design's own variable table (get_variable_defs), verbatim. Stored scoped to this page and this reference so studio_measure_reference answers by LOOKUP instead of guessing a colour from pixels. Up to ${MAX_VARIABLES_PER_INGEST} per call — pass the rest with studio_ingest_design_variables.`,
      }),
    ),
    mode: Type.Optional(
      Type.Union(FIDELITY_MODES.map((m) => Type.Literal(m)), {
        description: 'Fidelity mode recorded ON the reference. Defaults to "strict" — a Figma frame is an exact spec, and that is the whole point of importing it as data rather than eyeballing it. Pass "balanced" or "creative" only when the user has said this design is directional.',
      }),
    ),
    label: Type.Optional(
      Type.String({ minLength: 1, description: 'Human-readable name for the reference, e.g. "Checkout — Figma". Defaults to the Figma node\'s own layer name when the metadata carries one.' }),
    ),
  },
  { additionalProperties: false },
)

// ---------------------------------------------------------------------------
// Metadata traversal
// ---------------------------------------------------------------------------

interface MetadataSummary {
  readonly hiddenCount: number
  readonly hiddenNames: string[]
  readonly visitedCount: number
  readonly truncated: boolean
}

/**
 * Walk the VISIBLE tree, tallying what was dropped on the way.
 *
 * A `visible: false` node is not descended into: everything under a hidden
 * layer is hidden too, and counting its subtree would inflate the tally into
 * something a reader cannot act on. `visible` absent means visible — that is
 * Figma's own default and how its API omits the field.
 */
function summarizeMetadata(root: FigmaNode): MetadataSummary {
  const hiddenNames: string[] = []
  let hiddenCount = 0
  let visitedCount = 0
  let truncated = false

  const stack: FigmaNode[] = [root]
  while (stack.length > 0) {
    if (visitedCount >= MAX_METADATA_NODES) {
      truncated = true
      break
    }
    const node = stack.pop()!
    visitedCount += 1
    for (const child of node.children ?? []) {
      if (child.visible === false) {
        hiddenCount += 1
        if (hiddenNames.length < MAX_HIDDEN_NAMES) hiddenNames.push(child.name ?? child.id ?? '(unnamed layer)')
        continue
      }
      stack.push(child)
    }
  }

  return { hiddenCount, hiddenNames, visitedCount, truncated }
}

export interface DetectedScreen {
  readonly name: string
  readonly nodeId: string | null
  readonly width: number
  readonly height: number
}

/** `screenDetection` — a stable code, not prose. Documented in `docs/features/agent.md`. */
export type ScreenDetection =
  | 'single-frame'
  | 'section-of-screens'
  | 'no-metadata'
  | 'no-bounding-box'

export interface ScreenDetectionResult {
  readonly detection: ScreenDetection
  readonly screens: DetectedScreen[]
  readonly truncated: boolean
}

/**
 * Is this node ONE screen, or a container of N screens?
 *
 * Mechanical, and deliberately conservative — a false "section" would send
 * the agent off building four pages the user never asked for, which is far
 * worse than the false "single frame" it degrades to. A node counts as a
 * section only when at least two of its VISIBLE direct children are
 * FRAME-like, each at least {@link MIN_SCREEN_WIDTH} x
 * {@link MIN_SCREEN_HEIGHT}, and each at least
 * {@link SCREEN_HEIGHT_RATIO} of the parent's own height. That last clause
 * is the one that does the work: screens sit SIDE BY SIDE in a section, so
 * they are nearly as tall as it; the hero and header inside a single screen
 * STACK, so each is a fraction of its height.
 */
export function detectScreens(root: FigmaNode): ScreenDetectionResult {
  const rootBox = root.absoluteBoundingBox
  if (!rootBox) return { detection: 'no-bounding-box', screens: [], truncated: false }

  const FRAME_LIKE = new Set(['FRAME', 'SECTION', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE'])
  const candidates: DetectedScreen[] = []
  for (const child of root.children ?? []) {
    if (child.visible === false) continue
    if (!child.type || !FRAME_LIKE.has(child.type.toUpperCase())) continue
    const box = child.absoluteBoundingBox
    if (!box) continue
    if (box.width < MIN_SCREEN_WIDTH || box.height < MIN_SCREEN_HEIGHT) continue
    if (box.height < rootBox.height * SCREEN_HEIGHT_RATIO) continue
    candidates.push({
      name: child.name ?? child.id ?? '(unnamed frame)',
      nodeId: child.id ?? null,
      width: Math.round(box.width),
      height: Math.round(box.height),
    })
  }

  if (candidates.length < 2) return { detection: 'single-frame', screens: [], truncated: false }
  return {
    detection: 'section-of-screens',
    screens: candidates.slice(0, MAX_SCREENS),
    truncated: candidates.length > MAX_SCREENS,
  }
}

// ---------------------------------------------------------------------------
// Board frame sizing
// ---------------------------------------------------------------------------

/** `frame.status` — a stable code. Documented in `docs/features/agent.md`. */
export type FrameSizeStatus =
  | 'resized'
  | 'already-matched'
  | 'no-bounding-box'
  | 'out-of-range'
  | 'no-frame-for-page'
  | 'section-not-sized'

interface FrameSizeResult {
  readonly status: FrameSizeStatus
  readonly width: number | null
  readonly height: number | null
  readonly note?: string
}

/**
 * Set `pageId`'s board frame to the Figma frame's own box.
 *
 * `syncBoardFramesFromDisk` runs first for the same reason
 * `studio_screenshot` calls it: the agent may have written the page's `.tsx`
 * moments ago and nothing watches the filesystem, so the page can be real,
 * parseable, and not yet on any board. Sizing a frame that does not exist
 * yet would report a confusing "no frame for this page" for a page the agent
 * just created.
 *
 * Same file, same write path as `studio_set_frames` (`boardFrames.ts` owns
 * every server-side board write). Board geometry is filesystem state, not a
 * page tree — see `editTools.ts`'s module doc for why writing it headlessly
 * is not the shape `mcp-tooling.md` forbids.
 */
function applyFrameSize(dir: string, pageId: string, box: { width: number; height: number } | undefined): FrameSizeResult {
  if (!box) {
    return {
      status: 'no-bounding-box',
      width: null,
      height: null,
      note: 'No absoluteBoundingBox in the metadata, so the board frame was left at whatever size it already had — every comparison against this reference will be resampled rather than exact. Fetch the node metadata through your Figma connector and call this tool again with it.',
    }
  }

  const width = Math.round(box.width)
  const height = Math.round(box.height)
  if (
    !Number.isFinite(width) || !Number.isFinite(height)
    || width < MIN_FRAME_EDGE || height < MIN_FRAME_EDGE
    || width > MAX_FRAME_EDGE || height > MAX_FRAME_EDGE
  ) {
    return {
      status: 'out-of-range',
      width: null,
      height: null,
      note: `The metadata's absoluteBoundingBox is ${box.width}x${box.height}, outside the ${MIN_FRAME_EDGE}-${MAX_FRAME_EDGE}px range a board frame can be. The board frame was left alone; check you passed the FRAME's metadata and not the whole page's.`,
    }
  }

  syncBoardFramesFromDisk(dir)

  const boardsFile = readBoardsFile(dir)
  let found = false
  let changed = false
  const boards: Board[] = boardsFile.boards.map((board) => {
    let next = board
    for (const frame of board.frames) {
      if (frame.pageId !== pageId) continue
      found = true
      if (frame.width === width && frame.height === height) continue
      next = resizeFrame(next, frame.id, width, height)
      changed = true
    }
    return next
  })

  if (!found) {
    return {
      status: 'no-frame-for-page',
      width,
      height,
      note: `No board frame exists for page "${pageId}", so its size could not be set to ${width}x${height}. Call studio_list_pages to see the real page ids — a page that has no source file on disk yet gets no frame.`,
    }
  }
  if (!changed) return { status: 'already-matched', width, height }

  const updated: BoardsFile = { ...boardsFile, boards }
  writeBoardsFile(dir, updated)
  return { status: 'resized', width, height }
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

const importFigmaFrameTool: AiTool = {
  name: 'studio_import_figma_frame',
  scope: 'shared',
  execution: 'server',
  mutates: true,
  requiredCapabilities: ['studio.write'],
  description:
    'Import one Figma frame as this page\'s design spec, in ONE call — the six-step ritual (register the export, remember mode:"strict", ingest the variables scoped to the new reference id, find the page, resize the board frame to the design\'s own size) collapsed into one, in the right order. Studio never talks to Figma: fetch everything through YOUR Figma connector first, then hand it over here. Pass pageId (required, from studio_list_pages) plus any of: exportPath (the PNG your connector downloaded, inside this project — registers it as a role:"spec" reference at mode:"strict"), node (the get_metadata JSON, pasted UNEDITED — its absoluteBoundingBox resizes the board frame to the Figma frame\'s own pixel size, which is what makes studio_compare exact instead of resampled, and its visible:false subtrees are counted and named back so you do not build layers the designer turned off), variables (the get_variable_defs table, stored scoped to this page + reference so studio_measure_reference answers by lookup instead of sampling pixels), and url (recorded as provenance; parsed and echoed back as { fileKey, nodeId } in the colon form Figma\'s own tools want). Every leg reports its own status code and, when it is not the happy path, a note saying exactly what to do next — a missing export does not fail the frame resize. If the metadata describes a SECTION holding sibling screen-sized frames, nothing is resized and the result enumerates the screens with their names, node ids and sizes: create one Studio page per screen, then call this tool once per screen with that child\'s own metadata. No Figma token is accepted, stored or returned.',
  inputSchema: ImportFigmaFrameInputSchema,
  handler: async (input, ctx: ToolContext) => {
    // Named fields only, never a spread: a field added to the schema later
    // must not be able to reach an internal option by accident.
    const {
      dir: dirInput,
      pageId,
      url,
      exportPath,
      node,
      variables,
      mode,
      label,
    } = input as {
      dir?: string
      pageId: string
      url?: string
      exportPath?: string
      node?: FigmaNode
      variables?: DesignVariableEntry[]
      mode?: FidelityMode
      label?: string
    }

    if (exportPath === undefined && node === undefined && variables === undefined) {
      return {
        ok: false,
        error:
          'Nothing to import. Pass at least one of exportPath (the export your Figma connector downloaded), node (the get_metadata JSON) or variables (the get_variable_defs table). With none of the three there is nothing to register, nothing to size the frame from and nothing to look values up in.',
      }
    }

    const dir = resolveToolProjectDir(dirInput, ctx)

    // --- Figma identifiers (provenance only; nothing is fetched) ---
    const parsedUrl = url === undefined ? null : parseFigmaUrl(url)
    const figma = {
      url: url ?? null,
      fileKey: parsedUrl?.fileKey ?? null,
      nodeId: parsedUrl && !parsedUrl.nodeIdPlaceholder ? (parsedUrl.nodeId ?? null) : null,
      ...(url !== undefined && parsedUrl?.fileKey === undefined
        ? { note: `"${url}" is not a recognisable Figma file URL, so no fileKey/nodeId could be read from it. It is still recorded verbatim as the reference's provenance.` }
        : {}),
    }

    // --- Metadata: hidden layers + section detection ---
    const metadata = node ? summarizeMetadata(node) : null
    const screenResult: ScreenDetectionResult = node
      ? detectScreens(node)
      : { detection: 'no-metadata', screens: [], truncated: false }
    const isSection = screenResult.detection === 'section-of-screens'

    // --- Board frame ---
    // A section is not a screen: sizing this page's frame to the section's
    // own box would produce one enormous frame containing N designs, and
    // every comparison against it would be meaningless. Enumerate instead.
    const frame: FrameSizeResult = isSection
      ? {
          status: 'section-not-sized',
          width: null,
          height: null,
          note: `This metadata describes a container of ${screenResult.screens.length} screen-sized frames, not one screen, so no board frame was resized. Create one Studio page per screen below, then call studio_import_figma_frame once per screen with that child's own metadata and its own export.`,
        }
      : applyFrameSize(dir, pageId, node?.absoluteBoundingBox)

    // --- Design reference ---
    let reference: { status: 'not-provided' | 'registered' | 'failed'; note?: string; reference?: DesignReference } = {
      status: 'not-provided',
      note: 'No exportPath, so no design reference was registered and studio_compare still has nothing to measure this page against. Download the frame\'s export through your Figma connector and call this tool again with its path.',
    }
    if (exportPath !== undefined) {
      const read = await readProjectImageBytes(dir, exportPath)
      if (!read.ok) {
        reference = { status: 'failed', note: read.error }
      } else {
        const registered = await registerDesignReference(dir, read.bytes, {
          pageId,
          role: 'spec',
          mode: mode ?? 'strict',
          ...(label !== undefined ? { label } : node?.name ? { label: node.name } : {}),
          ...(url !== undefined ? { source: url } : {}),
        })
        reference = registered.ok
          ? { status: 'registered', reference: registered.reference }
          : { status: 'failed', note: registered.error }
      }
    }

    const referenceId = reference.reference?.id

    // --- Design variables ---
    let variableSet: { status: 'not-provided' | 'ingested'; note?: string; id?: string; variableCount?: number; colorCount?: number; sizeCount?: number; otherCount?: number } = {
      status: 'not-provided',
      note: 'No variables passed, so studio_measure_reference will infer colours and sizes from pixels rather than look them up. Call your connector\'s get_variable_defs and pass the table here or to studio_ingest_design_variables.',
    }
    if (variables !== undefined) {
      const ingested = ingestDesignVariables(dir, toRawDesignVariableEntries(variables), {
        source: url ?? `figma frame import for page "${pageId}"`,
        pageId,
        ...(referenceId !== undefined ? { referenceId } : {}),
        ...(label !== undefined ? { label } : {}),
      })
      variableSet = {
        status: 'ingested',
        id: ingested.set.id,
        variableCount: ingested.set.variables.length,
        colorCount: ingested.colorCount,
        sizeCount: ingested.sizeCount,
        otherCount: ingested.otherCount,
      }
    }

    // Frame geometry changed on disk; nudge an open board to re-read it. Same
    // best-effort push `studio_set_frames` makes, and for the same reason.
    if (frame.status === 'resized') pushStudioLiveReload(ctx.userId, { dir, boardsChanged: true })

    return {
      ok: true,
      dir,
      pageId,
      figma,
      frame,
      reference,
      variables: variableSet,
      screenDetection: screenResult.detection,
      screens: screenResult.screens,
      ...(screenResult.truncated
        ? { screensTruncated: true, screensNote: `More than ${MAX_SCREENS} screen-sized frames were found; only the first ${MAX_SCREENS} are listed. That is usually a whole Figma page rather than one section — pass a narrower node.` }
        : {}),
      hiddenLayers: metadata
        ? {
            count: metadata.hiddenCount,
            names: metadata.hiddenNames,
            ...(metadata.hiddenCount > metadata.hiddenNames.length ? { omittedNames: metadata.hiddenCount - metadata.hiddenNames.length } : {}),
            ...(metadata.hiddenCount > 0
              ? { note: 'These layers are hidden in Figma. They are NOT part of the design — do not build them, and do not treat their absence from the export as a mistake.' }
              : {}),
            ...(metadata.truncated
              ? { metadataTruncated: true, metadataNote: `Metadata traversal stopped at ${MAX_METADATA_NODES} nodes; the hidden-layer tally covers only what was visited. Pass one frame's metadata rather than a whole page's.` }
              : {}),
          }
        : null,
    }
  },
}

export const studioImportFigmaFrameMcpTools: AiTool[] = [importFigmaFrameTool]
