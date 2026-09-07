/**
 * TypeBox input schemas for the Studio tools that address a BOARD FRAME —
 * its preview axes, its variants, and the two reads that measure what a frame
 * actually rendered.
 *
 * Split out of `toolSchemas.ts` (which is a catalogue of every tool's input
 * shape and was pushing the module ceiling) because these five share more than
 * a neighbourhood: the axes patch, the optional `dir` field, and the
 * pageId + optional frameId addressing rule are one vocabulary, and W9-6 moved
 * all of them onto one execution model — server-side, against what is on disk,
 * with the user's editor tab as a fallback rather than a requirement.
 */
import { Type } from '@core/utils/typeboxHelpers'

// ---------------------------------------------------------------------------
// studio_set_frame_axes / studio_duplicate_frame_as_variant (WS-12 §6.1).
// They shipped browser-bridged, the same pattern `studio_export_frames`
// follows. W9-6: both now run SERVER-side. A frame's axes
// override and a variant frame are `.studio/boards.json` state, not editor
// state — so the honest target is the file, written the way every other board
// route writes it, with a live-reload push so an open tab re-reads it. They
// used to relay to the user's tab and spend ~8s of bridge timeout when none
// was open, for a write that never needed one.
//
// Both address a frame by `pageId` (the id every other Studio tool already
// returns) rather than a raw board `frameId`, which no tool exposes to an
// agent at all — when a page has more than one frame/variant, the FIRST one
// found is targeted; pass `frameId` explicitly (returned by
// studio_duplicate_frame_as_variant) to address a specific one.
// ---------------------------------------------------------------------------

const StudioFrameAxesPatchSchema = Type.Object({
  direction: Type.Optional(Type.Union([Type.Literal('ltr'), Type.Literal('rtl')])),
  colorScheme: Type.Optional(Type.Union([Type.Literal('light'), Type.Literal('dark')])),
  locale: Type.Optional(Type.String({ minLength: 1 })),
})

/** The optional project directory every server-executed Studio tool takes. Defaults to the turn's own open project. */
const StudioToolDirField = Type.Optional(
  Type.String({
    description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.',
  }),
)

export const StudioSetFrameAxesInputSchema = Type.Object({
  dir: StudioToolDirField,
  pageId: Type.String({ minLength: 1, description: 'Studio page id (from studio_list_pages) whose board frame gets the override.' }),
  frameId: Type.Optional(Type.String({ description: 'Address a SPECIFIC frame when the page has more than one (a "duplicate as variant" result) — omit to target the first frame found for pageId.' })),
  axes: StudioFrameAxesPatchSchema,
})

/**
 * `studio_computed_styles` — what a screen's CSS ACTUALLY resolved to.
 *
 * The gap this closes: the agent could see the design's intended values (a
 * Figma connector's variable definitions) and a picture of its own output, but
 * never the values its own stylesheet computed to. So "does this button render
 * at 14px?" was answerable only by squinting at a screenshot, and a label
 * rendering at the wrong size survived four rounds of corrections — each one
 * editing a number that was already right.
 *
 * Deliberately per-NODE rather than per-component: it needs no catalogue of
 * component variants and no knowledge of what `size="default"` means, so it
 * covers buttons, inputs and everything else the same way.
 *
 * W9-6 — answered by the HEADLESS capture page by default, with the user's
 * open tab as the fallback. The question is about what is on disk, which is
 * what the capture page renders, so requiring a browser tab was a cost with no
 * matching truth.
 */
export const StudioComputedStylesInputSchema = Type.Object({
  dir: StudioToolDirField,
  pageId: Type.String({ minLength: 1, description: 'Studio page id (from studio_list_pages) whose rendered frame is read.' }),
  nodeIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: 'Restrict to these node ids (from studio_screenshot\'s nodeRects or studio_find_nodes). Omit to report every node in the frame that renders text or a visible box.',
  })),
  textOnly: Type.Optional(Type.Boolean({
    description: 'Default true — report only nodes with their own text, which is what a type mismatch lives on. Set false to include layout containers (their padding, radius and background).',
  })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 300, description: 'Cap on reported nodes. Default 80, with an honest truncated count.' })),
})

export const StudioDuplicateFrameAsVariantInputSchema = Type.Object({
  dir: StudioToolDirField,
  pageId: Type.String({ minLength: 1, description: 'Studio page id whose board frame is duplicated as a new, independently-addressable variant frame.' }),
  frameId: Type.Optional(Type.String({ description: 'Duplicate a SPECIFIC frame when the page already has more than one — omit to duplicate the first frame found for pageId.' })),
  axes: StudioFrameAxesPatchSchema,
})

/**
 * `studio_measure_element` — the rendered GEOMETRY of a screen's own boxes.
 *
 * Every capture already computes `nodeRects` and throws away everything around
 * them: the padding inside each box, the margins around it, and the measured
 * distance to its neighbours. So "the cards are too close together" was
 * answered by estimating pixels off a picture and editing a gap that was
 * already correct — the same failure mode `studio_computed_styles` fixed for
 * type, one axis over.
 *
 * Reports the measured gap AND the parent's declared `row-gap`/`column-gap`
 * side by side, because that pair is the whole diagnosis: when they disagree,
 * a margin is in play and no amount of tuning the `gap` will close it.
 */
export const StudioMeasureElementInputSchema = Type.Object({
  dir: StudioToolDirField,
  page: Type.String({
    minLength: 1,
    description: 'Which screen to measure, by name — "Checkout", "Checkout.tsx", "pages/Checkout.tsx", or a raw page id all work.',
  }),
  nodeIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
    description: 'Restrict to these node ids (from studio_screenshot\'s nodeRects). A requested id that renders nothing comes back in `unmatched` rather than being silently dropped.',
  })),
  selector: Type.Optional(Type.String({
    minLength: 1,
    description: 'A CSS selector evaluated inside the rendered frame (e.g. "[data-node-id] > button", ".card"). Unioned with nodeIds when both are given. Omit both to measure every authored node.',
  })),
  limit: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 200,
    description: 'Cap on reported elements. Default 40, with an honest truncated count.',
  })),
  axes: Type.Optional(Type.Object(
    {
      direction: Type.Optional(Type.Union([Type.Literal('ltr'), Type.Literal('rtl')])),
      colorScheme: Type.Optional(Type.Union([Type.Literal('light'), Type.Literal('dark')])),
    },
    { description: 'Measure under a temporary direction/color-scheme override — how to check the RTL layout\'s spacing without changing anything.' },
  )),
})
