/**
 * AI site write-tool INPUT schemas — the single source of truth.
 *
 * These TypeBox schemas define the input shape of every browser-bridged site
 * write tool. They are consumed by BOTH sides of the bridge:
 *
 *   - `server/ai/tools/site/writeTools.ts` uses each schema as the tool's
 *     `inputSchema` (the model-facing JSON Schema the driver advertises).
 *   - `src/admin/pages/site/agent/executor.ts` + `tokenRunners.ts` validate
 *     the incoming `toolRequest` payload with `parseValue(schema, raw)` before
 *     applying the mutation against the editor store.
 *
 * Before this leaf existed the schemas were declared THREE times (server tools,
 * executor, token runners) and silently drifted. Now they live here once: a
 * server-side constraint and the browser-side validation can never disagree,
 * and adding a required field breaks both consumers at build time.
 *
 * This module is a pure, dependency-free leaf — TypeBox only, no server- or
 * browser-runtime imports — so both `server/` and `src/admin/` may import it
 * (mirrors `@core/css-sanitize` / `@core/framework-schema`). Keep it that way.
 *
 * Two provider-boundary constraints intentionally add a second validation
 * layer in the browser executor:
 *
 *   - `render_snapshot` adds the server-set `captureScreenshot` flag on top of
 *     the model-facing `RenderSnapshotInputSchema`.
 *   - `site_apply_css` advertises one flat object because Anthropic rejects
 *     `anyOf`/`oneOf`/`allOf` at a tool schema's root. The executor validates
 *     that object against `ApplyCssExecutionInputSchema`, the exact
 *     discriminated union. Both schemas reuse the field definitions below.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'

// ---------------------------------------------------------------------------
// Document refs
// ---------------------------------------------------------------------------

export const AgentDocumentRefSchema = Type.Union([
  Type.Object({
    type: Type.Literal('page'),
    id: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    type: Type.Literal('template'),
    id: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    type: Type.Literal('visualComponent'),
    id: Type.String({ minLength: 1 }),
  }),
])
export type AgentDocumentRef = Static<typeof AgentDocumentRefSchema>

// ---------------------------------------------------------------------------
// HTML-native write tools
// ---------------------------------------------------------------------------

export const InsertHtmlInputSchema = Type.Object({
  parentId: Type.String({ minLength: 1 }),
  index: Type.Optional(Type.Integer({ minimum: 0 })),
  html: Type.String({ minLength: 1 }),
})
export type InsertHtmlInput = Static<typeof InsertHtmlInputSchema>

export const GetNodeHtmlInputSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
})
export type GetNodeHtmlInput = Static<typeof GetNodeHtmlInputSchema>

export const ReadDocumentInputSchema = Type.Object({
  document: Type.Optional(AgentDocumentRefSchema),
  part: Type.Optional(Type.Integer({ minimum: 1 })),
})
export type ReadDocumentInput = Static<typeof ReadDocumentInputSchema>

export const OpenDocumentInputSchema = Type.Object({
  document: AgentDocumentRefSchema,
})
export type OpenDocumentInput = Static<typeof OpenDocumentInputSchema>

export const ReplaceNodeHtmlInputSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  html: Type.String({ minLength: 1 }),
})
export type ReplaceNodeHtmlInput = Static<typeof ReplaceNodeHtmlInputSchema>

// ---------------------------------------------------------------------------
// Node-level write tools
// ---------------------------------------------------------------------------

export const DeleteNodeInputSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
})
export type DeleteNodeInput = Static<typeof DeleteNodeInputSchema>

export const UpdateNodePropsInputSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  breakpointId: Type.Optional(Type.String({ minLength: 1 })),
  patch: Type.Record(Type.String(), Type.Unknown()),
})
export type UpdateNodePropsInput = Static<typeof UpdateNodePropsInputSchema>

export const MoveNodeInputSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  newParentId: Type.String({ minLength: 1 }),
  newIndex: Type.Integer({ minimum: 0 }),
})
export type MoveNodeInput = Static<typeof MoveNodeInputSchema>

export const RenameNodeInputSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
})
export type RenameNodeInput = Static<typeof RenameNodeInputSchema>

export const DuplicateNodeInputSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
})
export type DuplicateNodeInput = Static<typeof DuplicateNodeInputSchema>

// ---------------------------------------------------------------------------
// CSS + class-assignment write tools
// ---------------------------------------------------------------------------

const CssTextInputSchema = Type.String({
  minLength: 1,
  description: 'Required for merge and replace. Contains complete CSS rules, including their selectors.',
})
const CssSelectorListInputSchema = Type.Array(
  Type.String({ minLength: 1 }),
  {
    minItems: 1,
    maxItems: 100,
    uniqueItems: true,
    description: 'Required for delete and remove-properties. Each entry is one exact emitted selector.',
  },
)
const CssPropertyNameInputSchema = Type.String({
  minLength: 1,
  pattern: '^-{0,2}[a-zA-Z][a-zA-Z0-9-]*$',
})
const CssPropertyListInputSchema = Type.Array(
  CssPropertyNameInputSchema,
  {
    minItems: 1,
    maxItems: 100,
    uniqueItems: true,
    description: 'Required only for remove-properties. Names use CSS kebab-case, including vendor/custom properties.',
  },
)
const CssMergeOperationSchema = Type.Literal('merge')
const CssReplaceOperationSchema = Type.Literal('replace')
const CssDeleteOperationSchema = Type.Literal('delete')
const CssRemovePropertiesOperationSchema = Type.Literal('remove-properties')
const CssOperationSchema = Type.Union([
  CssMergeOperationSchema,
  CssReplaceOperationSchema,
  CssDeleteOperationSchema,
  CssRemovePropertiesOperationSchema,
], {
  description: 'The CSS mutation to perform. Its required companion fields are documented on css, selectors, and properties.',
})

/**
 * Provider-facing tool schema. Tool providers require an ordinary object at
 * the root, and Anthropic explicitly rejects root-level schema composition.
 * The descriptions state each operation's required fields; the browser then
 * enforces the exact discriminated shape with ApplyCssExecutionInputSchema.
 */
export const ApplyCssInputSchema = Type.Object({
  operation: CssOperationSchema,
  css: Type.Optional(CssTextInputSchema),
  selectors: Type.Optional(CssSelectorListInputSchema),
  properties: Type.Optional(CssPropertyListInputSchema),
}, { additionalProperties: false })

/**
 * Exact CSS-registry mutation accepted at the editor-store boundary. The
 * discriminator keeps destructive replacement/deletion impossible to trigger
 * accidentally by omitting an optional field from a normal merge.
 */
export const ApplyCssExecutionInputSchema = Type.Union([
  Type.Object({
    operation: CssMergeOperationSchema,
    css: CssTextInputSchema,
  }),
  Type.Object({
    operation: CssReplaceOperationSchema,
    css: CssTextInputSchema,
  }),
  Type.Object({
    operation: CssDeleteOperationSchema,
    selectors: CssSelectorListInputSchema,
  }),
  Type.Object({
    operation: CssRemovePropertiesOperationSchema,
    selectors: CssSelectorListInputSchema,
    properties: CssPropertyListInputSchema,
  }),
])
export type ApplyCssInput = Static<typeof ApplyCssInputSchema>
export type ApplyCssExecutionInput = Static<typeof ApplyCssExecutionInputSchema>

export const AssignClassInputSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  classId: Type.String({ minLength: 1 }),
})
export type AssignClassInput = Static<typeof AssignClassInputSchema>

export const RemoveClassInputSchema = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  classId: Type.String({ minLength: 1 }),
})
export type RemoveClassInput = Static<typeof RemoveClassInputSchema>

// ---------------------------------------------------------------------------
// Code asset tools
// ---------------------------------------------------------------------------

const CodeAssetTypeSchema = Type.Union([
  Type.Literal('script'),
  Type.Literal('style'),
])

const CodeAssetRefInputSchema = Type.Object({
  fileId: Type.Optional(Type.String({ minLength: 1 })),
  path: Type.Optional(Type.String({ minLength: 1 })),
})

export const ListCodeAssetsInputSchema = Type.Object({
  type: Type.Optional(CodeAssetTypeSchema),
})
export type ListCodeAssetsInput = Static<typeof ListCodeAssetsInputSchema>

export const ReadCodeAssetInputSchema = Type.Composite([
  CodeAssetRefInputSchema,
  Type.Object({
    part: Type.Optional(Type.Integer({ minimum: 1 })),
    maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })),
  }),
])
export type ReadCodeAssetInput = Static<typeof ReadCodeAssetInputSchema>

export const WriteCodeAssetInputSchema = Type.Object({
  path: Type.String({ minLength: 1 }),
  type: CodeAssetTypeSchema,
  content: Type.String(),
  runtime: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  dependencies: Type.Optional(Type.Record(
    Type.String(),
    Type.String({ minLength: 1 }),
    {
      description:
        'Runtime npm dependencies required by a module script. Keys are package names, values are semver versions/ranges. Only valid when type is "script".',
    },
  )),
})
export type WriteCodeAssetInput = Static<typeof WriteCodeAssetInputSchema>

export const PatchCodeAssetInputSchema = Type.Composite([
  CodeAssetRefInputSchema,
  Type.Object({
    expectedHash: Type.String({ minLength: 1 }),
    replacements: Type.Array(
      Type.Object({
        oldText: Type.String({ minLength: 1 }),
        newText: Type.String(),
        replaceAll: Type.Optional(Type.Boolean()),
      }),
      { minItems: 1 },
    ),
  }),
])
export type PatchCodeAssetInput = Static<typeof PatchCodeAssetInputSchema>

export const InspectCodeRuntimeInputSchema = Type.Object({
  document: Type.Optional(AgentDocumentRefSchema),
})
export type InspectCodeRuntimeInput = Static<typeof InspectCodeRuntimeInputSchema>

// ---------------------------------------------------------------------------
// Page-level write tools
// ---------------------------------------------------------------------------

export const AddPageInputSchema = Type.Object({
  title: Type.String({ minLength: 1 }),
  slug: Type.Optional(Type.String()),
})
export type AddPageInput = Static<typeof AddPageInputSchema>

export const DeletePageInputSchema = Type.Object({
  pageId: Type.String({ minLength: 1 }),
})
export type DeletePageInput = Static<typeof DeletePageInputSchema>

export const RenamePageInputSchema = Type.Object({
  pageId: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  slug: Type.Optional(Type.String()),
})
export type RenamePageInput = Static<typeof RenamePageInputSchema>

export const DuplicatePageInputSchema = Type.Object({
  pageId: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  slug: Type.Optional(Type.String()),
})
export type DuplicatePageInput = Static<typeof DuplicatePageInputSchema>

// ---------------------------------------------------------------------------
// Template write tools
//
// The target shape intentionally matches `TemplateTargetSchema` in
// `@core/page-tree`; it is redefined here (not imported) to keep this module a
// dependency-free leaf rather than pulling in the page-tree engine.
// ---------------------------------------------------------------------------

const TemplateTargetInputSchema = Type.Union([
  Type.Object({ kind: Type.Literal('everywhere') }),
  Type.Object({
    kind: Type.Literal('postTypes'),
    tableSlugs: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  }),
  Type.Object({ kind: Type.Literal('notFound') }),
])

export const SetPageTemplateInputSchema = Type.Object({
  pageId: Type.String({ minLength: 1 }),
  target: TemplateTargetInputSchema,
  priority: Type.Optional(Type.Number()),
})
export type SetPageTemplateInput = Static<typeof SetPageTemplateInputSchema>

export const ClearPageTemplateInputSchema = Type.Object({
  pageId: Type.String({ minLength: 1 }),
})
export type ClearPageTemplateInput = Static<typeof ClearPageTemplateInputSchema>

// ---------------------------------------------------------------------------
// Design-system token write tools
//
// Colors and fonts are LIST-shaped (one entry per token); typography and
// spacing are SCALE-shaped (a group config from which the framework generates
// per-step values).
// ---------------------------------------------------------------------------

export const SetColorTokensInputSchema = Type.Object({
  tokens: Type.Array(
    Type.Object({
      slug: Type.String({ minLength: 1 }),
      lightValue: Type.String({ minLength: 1 }),
      category: Type.Optional(Type.String()),
      darkValue: Type.Optional(Type.String()),
      darkModeEnabled: Type.Optional(Type.Boolean()),
    }),
    { minItems: 1 },
  ),
})

export const SetFontTokensInputSchema = Type.Object({
  tokens: Type.Array(
    Type.Object({
      name: Type.String({ minLength: 1 }),
      variable: Type.Optional(Type.String()),
      fallback: Type.Optional(Type.String()),
      googleFamily: Type.Optional(Type.String()),
      variants: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      subsets: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      familyId: Type.Optional(Type.String({ minLength: 1 })),
    }),
    { minItems: 1 },
  ),
})

/** A single scale anchor (min/max breakpoint) — `fontSize` for type, `size` for spacing. */
const ScaleBreakpointInputSchema = (sizeKey: 'fontSize' | 'size') =>
  Type.Object({
    [sizeKey]: Type.Optional(Type.Number()),
    scaleRatio: Type.Optional(Type.Union([Type.Number(), Type.String()])),
  })

export const SetTypeScaleInputSchema = Type.Object({
  groupId: Type.Optional(Type.String({ minLength: 1 })),
  namingConvention: Type.Optional(Type.String({ minLength: 1 })),
  steps: Type.Optional(Type.String({ minLength: 1 })),
  baseScaleIndex: Type.Optional(Type.Integer({ minimum: 0 })),
  min: Type.Optional(ScaleBreakpointInputSchema('fontSize')),
  max: Type.Optional(ScaleBreakpointInputSchema('fontSize')),
})

export const SetSpacingScaleInputSchema = Type.Object({
  groupId: Type.Optional(Type.String({ minLength: 1 })),
  namingConvention: Type.Optional(Type.String({ minLength: 1 })),
  steps: Type.Optional(Type.String({ minLength: 1 })),
  baseScaleIndex: Type.Optional(Type.Integer({ minimum: 0 })),
  min: Type.Optional(ScaleBreakpointInputSchema('size')),
  max: Type.Optional(ScaleBreakpointInputSchema('size')),
})

// ---------------------------------------------------------------------------
// render_snapshot
//
// MODEL-FACING shape only — `breakpointId`/`nodeId`. The browser executor
// composes a server-set `captureScreenshot` flag on top of this (non-vision
// models skip the expensive html-to-image capture); the model never sets it,
// so it stays out of the advertised tool schema.
// ---------------------------------------------------------------------------

export const RenderSnapshotInputSchema = Type.Object({
  breakpointId: Type.Optional(Type.String({ minLength: 1 })),
  nodeId: Type.Optional(Type.String({ minLength: 1 })),
})

// ---------------------------------------------------------------------------
// studio_export_frames (WS-9.2) — browser-bridged, batch Studio board capture
//
// Model-facing shape. Unlike `RenderSnapshotInputSchema` there is no
// `breakpointId`: every Studio board frame shares ONE synthetic breakpoint
// (`'studio'`, `BoardFramesLayer.tsx`), each at its OWN authored width — a
// tool-wide "width" parameter would silently misdescribe a project with
// differently-sized frames. Resize a frame first with `studio_set_frames` if
// a specific width is needed; the response reports each frame's actual
// captured width/height so a caller never has to guess what it got.
// ---------------------------------------------------------------------------

export const StudioExportFramesInputSchema = Type.Object({
  pageIds: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    maxItems: 20,
    description: 'Studio page ids (from studio_list_pages) to export, batched in one call. Each must be a frame on the currently open board.',
  }),
  dpr: Type.Optional(Type.Number({
    minimum: 0.5,
    maximum: 3,
    description: 'Output pixel-density multiplier applied to each frame\'s native captured size (e.g. 2 for a retina-equivalent PNG). Still capped so no image edge exceeds the shared vision-safe limit. Default 1.',
  })),
  axes: Type.Optional(Type.Object({
    direction: Type.Optional(Type.Union([Type.Literal('ltr'), Type.Literal('rtl')])),
    colorScheme: Type.Optional(Type.Union([Type.Literal('light'), Type.Literal('dark')])),
  }, {
    description:
      'WS-10 §5.3 — temporarily overrides the board\'s current direction/colorScheme for the duration of THIS call only (restored afterward), so an agent can request "the RTL rendering" or "the dark rendering" without leaving the live session in that state. Applies to every frame in the batch; a frame that already carries its own per-frame `axes` override (WS-10 §4.4, "duplicate as variant") still uses ITS OWN override — this call-level override only changes the BOARD DEFAULT the frame would otherwise inherit. `locale` is deliberately NOT here: it is parse-time (WS-10 §4.2) and this call cannot trigger a re-parse mid-batch — set the board\'s locale first (POST /admin/api/studio/preview-axes or the toolbar\'s locale control) and wait for it to finish re-parsing, THEN call this tool.',
  })),
})

// ---------------------------------------------------------------------------
// studio_set_frame_axes / studio_duplicate_frame_as_variant (WS-12 §6.1) —
// browser-bridged (execution: 'browser', scope: 'site'), same pattern as
// studio_export_frames above: this file only declares the shape, the real
// mutation runs client-side against the live board via `EditorStore.setFrameAxes`/
// `duplicateFrameAsVariant` (`executor.ts`), the same two actions the
// toolbar's own preview-axes/duplicate-as-variant controls call.
//
// Both address a frame by `pageId` (the id every other Studio tool already
// returns) rather than a raw board `frameId`, which no tool exposes to an
// agent at all — when a page has more than one frame/variant on the active
// board, the FIRST one found is targeted; pass `frameId` explicitly
// (returned by studio_duplicate_frame_as_variant) to address a specific one.
// ---------------------------------------------------------------------------

const StudioFrameAxesPatchSchema = Type.Object({
  direction: Type.Optional(Type.Union([Type.Literal('ltr'), Type.Literal('rtl')])),
  colorScheme: Type.Optional(Type.Union([Type.Literal('light'), Type.Literal('dark')])),
  locale: Type.Optional(Type.String({ minLength: 1 })),
})

export const StudioSetFrameAxesInputSchema = Type.Object({
  pageId: Type.String({ minLength: 1, description: 'Studio page id (from studio_list_pages) whose board frame gets the override.' }),
  frameId: Type.Optional(Type.String({ description: 'Address a SPECIFIC frame when the page has more than one (a "duplicate as variant" result) — omit to target the first frame found for pageId.' })),
  axes: StudioFrameAxesPatchSchema,
})

export const StudioDuplicateFrameAsVariantInputSchema = Type.Object({
  pageId: Type.String({ minLength: 1, description: 'Studio page id whose board frame is duplicated as a new, independently-addressable variant frame.' }),
  frameId: Type.Optional(Type.String({ description: 'Duplicate a SPECIFIC frame when the page already has more than one — omit to duplicate the first frame found for pageId.' })),
  axes: StudioFrameAxesPatchSchema,
})

// ---------------------------------------------------------------------------
// studio_upload_asset (WS-12 §6.1) — browser-bridged: the browser already
// knows which project is open and POSTs to the EXISTING
// POST /admin/api/studio/asset-upload endpoint (assetUpload.ts) as real
// multipart form data — this wraps that endpoint, it does not reimplement
// its validation (magic-number sniffing, containment, collision-safe naming).
// ---------------------------------------------------------------------------

export const StudioUploadAssetInputSchema = Type.Object({
  imageBase64: Type.String({ minLength: 1, description: 'Base64-encoded image bytes to land into the project as a new file.' }),
  mimeType: Type.Union(
    [Type.Literal('image/png'), Type.Literal('image/jpeg'), Type.Literal('image/webp')],
    { description: 'Declared type — the server sniffs the actual bytes and refuses a mismatch, this is only a hint.' },
  ),
  targetDir: Type.Optional(Type.String({ description: 'Workspace-relative directory to write into. Defaults to src/assets. Pass the directory an existing import already points at when replacing that import\'s target.' })),
})

// ---------------------------------------------------------------------------
// studio_list_components / studio_find_component — the design-system
// COMPONENT catalog, headless. Unlike every schema above, both tools are
// `execution: 'server'` with no live-store dependency at all (see
// `server/ai/mcp/tools/studio/componentCatalogTools.ts`), so there is no
// browser-executor half for these two to stay in sync with. Declared here
// anyway, grouped with this leaf's other `Studio*InputSchema` definitions,
// so every Studio MCP tool's input shape has one home regardless of which
// execution class it turns out to need.
// ---------------------------------------------------------------------------

const DIR_INPUT_DESCRIPTION = 'Absolute project directory. Defaults to the first project under studio-workspace/.'

export const StudioListComponentsInputSchema = Type.Object({
  dir: Type.Optional(Type.String({ description: DIR_INPUT_DESCRIPTION })),
  filter: Type.Optional(
    Type.String({ description: 'Case-insensitive substring match on the component name, e.g. "button" or "card".' }),
  ),
  package: Type.Optional(
    Type.String({ description: 'Restrict to one installed package by exact name (from the response\'s own "packages" list), when the project depends on more than one component package.' }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 200, description: 'Cap on returned components. Default 60.' }),
  ),
})

export const StudioFindComponentInputSchema = Type.Object({
  dir: Type.Optional(Type.String({ description: DIR_INPUT_DESCRIPTION })),
  name: Type.Optional(
    Type.String({ description: 'Case-insensitive substring match on the component name.' }),
  ),
  prop: Type.Optional(
    Type.String({ description: 'Case-insensitive substring match against any prop NAME a component declares, e.g. "variant" or "icon" — finds every component that has one, so their options can be compared before picking one.' }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 200, description: 'Cap on returned components. Default 40.' }),
  ),
})

// ---------------------------------------------------------------------------
// studio_list_component_bindings — the raw Figma Code Connect binding for a
// project's design-system component(s): the deep-dive sibling of
// studio_list_components'/studio_find_component's own `figma` summary field.
// `execution: 'server'`, headless, no live-store dependency — grouped here
// for the same reason as the two schemas immediately above.
// ---------------------------------------------------------------------------

export const StudioListComponentBindingsInputSchema = Type.Object({
  dir: Type.Optional(Type.String({ description: DIR_INPUT_DESCRIPTION })),
  filter: Type.Optional(
    Type.String({ description: 'Case-insensitive substring match on the component name, e.g. "button" or "card".' }),
  ),
  package: Type.Optional(
    Type.String({ description: 'Restrict to one installed package by exact name, when the project depends on more than one.' }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 200, description: 'Cap on returned bindings. Default 40.' }),
  ),
})

// ---------------------------------------------------------------------------
// studio_fetch_remote_asset — the bytes-never-transit-the-model path for
// landing an externally-hosted asset (a Figma export URL, most concretely)
// into the project. `execution: 'server'`, headless — the fetch and the
// write both happen server-side; see `server/handlers/studio/
// remoteAssetFetch.ts` for the URL-safety reasoning (scheme restriction, no
// redirect ever followed, streamed size cap) and `assetLanding.ts` for the
// write pipeline it shares with `studio_upload_asset`.
// ---------------------------------------------------------------------------

export const StudioFetchRemoteAssetInputSchema = Type.Object({
  dir: Type.Optional(Type.String({ description: DIR_INPUT_DESCRIPTION })),
  url: Type.String({
    minLength: 1,
    description:
      'An http:// or https:// URL that returns image bytes (e.g. a Figma export/download URL another tool already returned) to fetch SERVER-SIDE and land as a new file in the project. Never a data: URL, never a local/internal path. Use this INSTEAD of studio_upload_asset when you already have a URL rather than bytes in hand — it avoids round-tripping the asset\'s bytes through your own context. No redirect is ever followed; the actual response bytes are sniffed against real image magic numbers, and SVG content is sanitized, before anything is written.',
  }),
  targetDir: Type.Optional(
    Type.String({ description: 'Workspace-relative directory to write into. Defaults to src/assets. Pass the directory an existing import already points at when replacing that import\'s target.' }),
  ),
})

// ---------------------------------------------------------------------------
// studio_register_design_reference / studio_list_design_references /
// studio_read_design_reference / studio_recommend_export_dpr — a durable,
// per-project, addressable-by-id store for a ground-truth design comp
// (typically a Figma export) an agent measures a Studio frame against,
// instead of eyeballing it. All `execution: 'server'`, headless — see
// `server/handlers/studio/designReferenceStore.ts` for where/why it's
// stored, and `server/ai/mcp/tools/studio/diffFrames.ts` for how
// studio_diff_frames' `referenceId` input consumes it.
// ---------------------------------------------------------------------------

export const StudioRegisterDesignReferenceInputSchema = Type.Object({
  dir: Type.Optional(Type.String({ description: DIR_INPUT_DESCRIPTION })),
  url: Type.Optional(Type.String({
    minLength: 1,
    description:
      'An http:// or https:// URL that returns the reference\'s image bytes (e.g. a Figma export/download URL another tool already returned) — fetched SERVER-SIDE, never transiting you, the same studio_fetch_remote_asset pattern. Provide exactly one of url or imageBase64.',
  })),
  imageBase64: Type.Optional(Type.String({
    minLength: 1,
    description: 'Base64-encoded original image bytes, when you already hold them rather than a URL (e.g. an attachment). Provide exactly one of url or imageBase64. Prefer url when available — it avoids round-tripping the bytes through your own context.',
  })),
  pageId: Type.Optional(Type.String({ description: 'The Studio page id (from studio_list_pages) this is a design reference FOR. Optional, but required for studio_recommend_export_dpr and for filtering studio_list_design_references by page.' })),
  label: Type.Optional(Type.String({ description: 'A short human-readable name, e.g. "Homepage hero — Figma export".' })),
  source: Type.Optional(Type.String({ description: 'Free-form provenance, e.g. a Figma file/node URL, so a later reader knows where this came from.' })),
})

export const StudioListDesignReferencesInputSchema = Type.Object({
  dir: Type.Optional(Type.String({ description: DIR_INPUT_DESCRIPTION })),
  pageId: Type.Optional(Type.String({ description: 'Restrict to references registered for one Studio page id.' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: 'Cap on returned references. Default 50.' })),
})

export const StudioReadDesignReferenceInputSchema = Type.Object({
  dir: Type.Optional(Type.String({ description: DIR_INPUT_DESCRIPTION })),
  referenceId: Type.String({ minLength: 1, description: 'A studio_register_design_reference id (from its own result or studio_list_design_references).' }),
  includeImage: Type.Optional(Type.Boolean({
    description: 'When true, also returns the ORIGINAL image bytes as an MCP image block, so you can actually look at the reference (not only its metadata). Costs real context for a large reference — omit (default false) when only the metadata (dimensions, label, pageId) is needed, e.g. before calling studio_recommend_export_dpr or studio_diff_frames.',
  })),
})

export const StudioRecommendExportDprInputSchema = Type.Object({
  dir: Type.Optional(Type.String({ description: DIR_INPUT_DESCRIPTION })),
  pageId: Type.String({ minLength: 1, description: 'The Studio page id whose board frame you intend to export with studio_export_frames.' }),
  referenceId: Type.String({ minLength: 1, description: 'A studio_register_design_reference id to match the export resolution to.' }),
})

export const StudioDeleteDesignReferenceInputSchema = Type.Object({
  dir: Type.Optional(Type.String({ description: DIR_INPUT_DESCRIPTION })),
  referenceId: Type.String({ minLength: 1, description: 'A studio_register_design_reference id to remove. Removing an unknown or already-removed id is not an error.' }),
})
