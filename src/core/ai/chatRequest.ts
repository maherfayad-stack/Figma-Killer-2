import { Type, type Static } from '@core/utils/typeboxHelpers'
import {
  AI_USER_IMAGE_MAX_BASE64_CHARS,
  AI_USER_IMAGE_MAX_PER_MESSAGE,
  AiUserImageBlockSchema,
} from './userImage'

/**
 * Eight maximum-sized JPEGs occupy about 16 MB once base64 encoded. Reserve a
 * further 16 MiB for JSON framing and the bounded editor snapshot while keeping
 * the HTTP boundary finite before JSON parsing.
 */
export const AI_CHAT_MAX_REQUEST_BYTES = (
  AI_USER_IMAGE_MAX_PER_MESSAGE * AI_USER_IMAGE_MAX_BASE64_CHARS
) + (16 * 1024 * 1024)

const AiUserTextBlockSchema = Type.Object(
  {
    kind: Type.Literal('text'),
    text: Type.String(),
  },
  { additionalProperties: false },
)

/** User-authored chat content cannot inject assistant/tool blocks. */
export const AiUserContentBlockSchema = Type.Union([
  AiUserTextBlockSchema,
  AiUserImageBlockSchema,
])

export type AiUserContentBlock = Static<typeof AiUserContentBlockSchema>

const AiUserContentSchema = Type.Union([
  // Image-only prompt.
  Type.Array(AiUserImageBlockSchema, {
    minItems: 1,
    maxItems: AI_USER_IMAGE_MAX_PER_MESSAGE,
  }),
  // Mixed or text-only prompt. `contains` + `maxContains` makes the single-text
  // invariant part of the HTTP schema while still allowing images in any order.
  Type.Array(AiUserContentBlockSchema, {
    minItems: 1,
    maxItems: AI_USER_IMAGE_MAX_PER_MESSAGE + 1,
    contains: AiUserTextBlockSchema,
    maxContains: 1,
  }),
])

export const AiChatRequestBodySchema = Type.Object(
  {
    conversationId: Type.String({ minLength: 1 }),
    content: AiUserContentSchema,
    // The CMS Site editor's own shape (the live editor snapshot) — used only
    // when no Studio project is open. `buildCmsSiteSystemPrompt` validates it
    // separately.
    snapshot: Type.Optional(Type.Unknown()),
    /**
     * The open Studio project's absolute directory, when one is open.
     * Re-validated server-side (`resolveValidatedWorkspaceDir`) before use —
     * never trusted as-is. Two independent consumers, each re-validating for
     * its own purpose:
     *   - `chat.ts` (WS-12): which toolset/prompt this turn gets — the real
     *     Studio tools when a project is genuinely open, the CMS `site`
     *     tools otherwise.
     *   - `claudeCli.ts` (WS-11): the ONLY driver that spawns a real
     *     filesystem process, so the ONLY one for which "which project" is
     *     also a spawn-`cwd` question, not just a tool-selection one.
     * Every other driver ignores this field entirely.
     */
    workspaceDir: Type.Optional(Type.String()),
    /**
     * WS-12 §5 session controls — `claudeCli` only, ignored by every other
     * driver (they have no equivalent knob). Both map 1:1 onto the CLI's own
     * confirmed flags (`--effort`, `--permission-mode`), no translation layer.
     *
     * `'bypassPermissions'` is a real, forwardable mode (WS-12 §5.2, D5
     * §11.5) — but ONLY as an explicit per-turn user choice. It is never the
     * default this field falls back to when omitted, and Studio never infers
     * or persists it — see `claudeCli.ts`'s `resolvePermissionMode` doc
     * comment for the full reasoning and the belt-and-braces that enforces
     * this at the point the flag would actually reach a subprocess.
     */
    effort: Type.Optional(Type.Union([
      Type.Literal('low'), Type.Literal('medium'), Type.Literal('high'), Type.Literal('xhigh'), Type.Literal('max'),
    ])),
    permissionMode: Type.Optional(Type.Union([
      Type.Literal('default'), Type.Literal('acceptEdits'), Type.Literal('plan'), Type.Literal('bypassPermissions'),
    ])),
    /**
     * W9-2 — how strictly this turn is meant to match the design, and how
     * much invention it is allowed. Tier 3 of `resolveFidelityMode`'s
     * precedence (`server/handlers/studio/fidelityMode.ts`): an explicit
     * tool argument and the resolved design reference's own `mode` both
     * outrank it; the persisted per-project default and the derived
     * "reference armed → balanced, none → creative" sit below it.
     *
     * Consumed server-side in two places, both Studio-only: the system
     * prompt's static prefix gains this mode's block (so each mode is its own
     * prompt-cache partition), and `studio_compare` reads the mode's
     * thresholds. Every non-`claudeCli` driver ignores it exactly as it
     * ignores `effort`/`permissionMode` — there is no provider knob to map it
     * onto, and it is a prompt/verification setting rather than a model one.
     */
    fidelityMode: Type.Optional(Type.Union([
      Type.Literal('creative'), Type.Literal('balanced'), Type.Literal('strict'),
    ])),
  },
  { additionalProperties: false },
)

export type AiChatRequestBody = Static<typeof AiChatRequestBodySchema>
