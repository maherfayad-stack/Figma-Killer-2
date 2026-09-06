/**
 * The wire contract between the headless capture DRIVER (server) and the
 * headless capture PAGE (browser) — `/admin/agent-capture`.
 *
 * Two hops, both validated with TypeBox at the boundary:
 *
 *   1. **Payload** (`AgentCapturePayloadSchema`) — server → page. Everything
 *      the capture page needs to render Studio's parse output for the
 *      requested screens and nothing else: the pages, the project's style
 *      registry, its raw authored/vendor CSS, its framework settings, and the
 *      authored frame geometry. No board, no editor state, no session.
 *   2. **Report** (`AgentCaptureReportSchema`) — page → server. Written to
 *      `window.__studioAgentCapture` once every frame has settled (or failed),
 *      read back by the driver through `page.evaluate` and validated before a
 *      single pixel is trusted.
 *
 * It lives in `@core/studio-capture` rather than in either half because both
 * halves genuinely own it: the server builds the payload and consumes the
 * report; the browser consumes the payload and builds the report. A leaf both
 * can import keeps one definition instead of two that drift.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { ConditionDefSchema, PageSchema, StyleRuleSchema } from '@core/page-tree'
import { FrameworkSettingsSchema } from '@core/framework-schema'
import { PreviewAxesSchema } from '@core/studio-board'

/** Where the capture page reports its readiness. Read by the driver via `page.evaluate`. */
export const AGENT_CAPTURE_GLOBAL = '__studioAgentCapture'

/** The route the headless browser navigates to. Query: `token`. */
export const AGENT_CAPTURE_ROUTE = '/admin/agent-capture'

/** Token-authenticated endpoints the capture page (and only it) calls. */
export const AGENT_CAPTURE_PAYLOAD_PATH = '/admin/api/agent-capture/payload'
export const AGENT_CAPTURE_ASSET_PATH = '/admin/api/agent-capture/asset'

/**
 * `data-agent-capture-frame="<pageId>"` marks the element the driver
 * screenshots. One per requested page, in the order they were requested.
 */
export const AGENT_CAPTURE_FRAME_ATTR = 'data-agent-capture-frame'

/** One frame's authored geometry — `frame.width/height` off `.studio/boards.json`, already defaulted server-side. */
export const AgentCaptureFrameSchema = Type.Object({
  pageId: Type.String({ minLength: 1 }),
  width: Type.Number({ minimum: 1 }),
  height: Type.Number({ minimum: 1 }),
})
export type AgentCaptureFrame = Static<typeof AgentCaptureFrameSchema>

export const AgentCapturePayloadSchema = Type.Object({
  dir: Type.String(),
  projectName: Type.String(),
  /** In the order the caller requested them; every entry has a matching page below. */
  frames: Type.Array(AgentCaptureFrameSchema),
  pages: Type.Array(PageSchema),
  styleRules: Type.Record(Type.String(), StyleRuleSchema),
  conditions: Type.Array(ConditionDefSchema),
  /** Raw project stylesheets in cascade order — `AuthoredCssInjector`'s input. */
  authoredCss: Type.String(),
  /** Third-party/design-system CSS, injected verbatim — `ProjectCssInjector`'s input. */
  vendorCss: Type.String(),
  /** `null` when the project has no `.studio/framework.json` yet; the default shell stands. */
  framework: Type.Union([FrameworkSettingsSchema, Type.Null()]),
  /** Render-time direction/colour-scheme override for this capture only. */
  axes: Type.Optional(Type.Partial(PreviewAxesSchema)),
})
export type AgentCapturePayload = Static<typeof AgentCapturePayloadSchema>

/** A node's rect in frame-local CSS px — identical shape to `studio_export_frames`' own `nodeRects`. */
export const AgentCaptureNodeRectSchema = Type.Object({
  nodeId: Type.String(),
  x: Type.Number(),
  y: Type.Number(),
  width: Type.Number(),
  height: Type.Number(),
})
export type AgentCaptureNodeRect = Static<typeof AgentCaptureNodeRectSchema>

export const AgentCaptureFrameReportSchema = Type.Union([
  Type.Object({
    pageId: Type.String(),
    ok: Type.Literal(true),
    /** CSS px — the driver multiplies by the effective ratio to get image px. */
    cssWidth: Type.Number(),
    cssHeight: Type.Number(),
    nodeRects: Type.Array(AgentCaptureNodeRectSchema),
    warnings: Type.Array(Type.String()),
  }),
  Type.Object({
    pageId: Type.String(),
    ok: Type.Literal(false),
    error: Type.String(),
  }),
])
export type AgentCaptureFrameReport = Static<typeof AgentCaptureFrameReportSchema>

export const AgentCaptureReportSchema = Type.Union([
  Type.Object({
    status: Type.Literal('ready'),
    frames: Type.Array(AgentCaptureFrameReportSchema),
  }),
  Type.Object({
    status: Type.Literal('error'),
    error: Type.String(),
  }),
])
export type AgentCaptureReport = Static<typeof AgentCaptureReportSchema>
