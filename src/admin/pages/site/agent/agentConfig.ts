/**
 * Site-editor agent network configuration.
 *
 * The site editor talks to Studio's one AI runtime surface at
 * `/admin/api/ai/chat` (provider-agnostic, multi-driver). The browser
 * tool results are posted through the shared admin AI bridge API.
 *
 * Endpoints live under `/admin/api/` so the session cookie scoped to
 * `Path=/admin` is sent by the browser. Outside `/admin/`, the cookie
 * wouldn't be carried and the `requireCapability('ai.chat' /
 * 'ai.tools.write')` gates would 401 every request.
 */

/** Studio's default endpoint — read at panel open to discover the active
    credential + model for new conversations. */
export const AI_DEFAULTS_PATH = '/admin/api/ai/defaults' as const

/** Conversations endpoint root — POST to create, GET to list. */
export const AI_CONVERSATIONS_PATH = '/admin/api/ai/conversations' as const
