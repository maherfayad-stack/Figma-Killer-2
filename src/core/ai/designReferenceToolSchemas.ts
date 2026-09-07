/**
 * Design-reference tool INPUT schemas — the `studio_*_design_reference` family
 * plus `studio_recommend_export_dpr`, split out of `toolSchemas.ts`.
 *
 * They left that file for the reason the split rule exists: `toolSchemas.ts`
 * documents itself as "AI site WRITE-tool input schemas", and these are not
 * site write tools. They describe a per-project, addressable-by-id store for
 * a ground-truth design comp (typically a Figma export) that an agent measures
 * a Studio frame against instead of eyeballing it — `execution: 'server'`,
 * headless, no browser bridge. See
 * `server/handlers/studio/designReferenceStore.ts` for where and why the bytes
 * are stored, `server/handlers/studio/designReferenceSchema.ts` for the
 * PERSISTED shape these inputs feed (including `role`, the spec-vs-context
 * distinction the resolution precedence turns on), and
 * `server/ai/mcp/tools/studio/referenceResolve.ts` for how a tool call with no
 * `referenceId` picks one.
 *
 * Same leaf discipline as `toolSchemas.ts`: TypeBox only, no server- or
 * browser-runtime imports, so both halves may import it.
 */

import { Type } from '@core/utils/typeboxHelpers'
import { DIR_INPUT_DESCRIPTION } from './toolSchemas'

/** `server/ai/mcp/tools/studio/diffFrames.ts` shows how `studio_diff_frames`' own `referenceId` input consumes what this registers. */
export const StudioRegisterDesignReferenceInputSchema = Type.Object({
  dir: Type.Optional(Type.String({ description: DIR_INPUT_DESCRIPTION })),
  url: Type.Optional(Type.String({
    minLength: 1,
    description:
      'An http:// or https:// URL that returns the reference\'s image bytes (e.g. a Figma export/download URL another tool already returned) — fetched SERVER-SIDE, never transiting you, the same studio_fetch_remote_asset pattern. Provide exactly one of url or imageBase64.',
  })),
  imageBase64: Type.Optional(Type.String({
    minLength: 1,
    description: 'Base64-encoded original image bytes, when you already hold them rather than a URL (e.g. an attachment). Provide exactly one of url, path or imageBase64. Prefer path or url when available — both avoid round-tripping the bytes through your own context.',
  })),
  path: Type.Optional(Type.String({
    minLength: 1,
    description:
      'Path to an image file ALREADY ON DISK inside this project, relative to the project root (e.g. ".studio/figma/hero.png"). This is the route to use after any tool that DOWNLOADS an export to disk — a Figma MCP server\'s asset-download tool, a shell fetch, anything. Read server-side; the bytes never transit you. Must resolve inside the project directory. Provide exactly one of url, path or imageBase64.',
  })),
  pageId: Type.Optional(Type.String({ description: 'The Studio page id (from studio_list_pages) this is a design reference FOR. Optional, but required for studio_recommend_export_dpr and for filtering studio_list_design_references by page.' })),
  label: Type.Optional(Type.String({ description: 'A short human-readable name, e.g. "Homepage hero — Figma export".' })),
  source: Type.Optional(Type.String({ description: 'Free-form provenance, e.g. a Figma file/node URL, so a later reader knows where this came from.' })),
  role: Type.Optional(Type.Union([Type.Literal('spec'), Type.Literal('context')], {
    description:
      'What this image IS. "spec" (the default for this tool) means it is the design the page is supposed to match — studio_compare measures against it. "context" means it is an image worth keeping but not the thing to match: a screenshot the user pasted to ask a question, a photo of a whiteboard, a before-picture. A spec always outranks a context image when a tool has to pick one implicitly, and a page with several equally-ranked candidates is refused by name rather than guessed — so registering a non-design as "spec" is how you break your own comparisons. Every image the user attaches to chat is registered as "context" automatically; pass role:"spec" here to promote one deliberately.',
  })),
  mode: Type.Optional(Type.Union([Type.Literal('creative'), Type.Literal('balanced'), Type.Literal('strict')], {
    description: 'How strictly THIS design is meant to be matched. Recorded on the reference; not yet read by any tool.',
  })),
  passScore: Type.Optional(Type.Number({
    minimum: 0,
    maximum: 100,
    description: 'Overall similarity percentage a studio_compare against THIS reference must reach to pass, overriding the tool default. Recorded on the reference; not yet read by any tool.',
  })),
  maxRegionCoverage: Type.Optional(Type.Number({
    minimum: 0,
    maximum: 100,
    description: 'Largest share of the frame (percent) any single differing region may cover and still pass, for THIS reference. Recorded on the reference; not yet read by any tool.',
  })),
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
