/**
 * AdminWorkspace — top-level admin section identifier.
 *
 * Defined here (not in a concrete layout) so editor chrome (e.g. Toolbar)
 * can reference the type without creating cycles through layout modules.
 */
/**
 * `'dashboard'` is the admin home — the first page every user lands on. A
 * configurable widget grid (visitors, pages, posts, storage, plugins, …)
 * plus a setup-onboarding panel. Gated by `dashboard.read`.
 *
 * `'account'` is the user's own settings page (profile, devices, security,
 * activity). Self-targeted — no capability gate; every authenticated user
 * can access their own. The avatar dropdown in the toolbar is the primary
 * entry point.
 *
 * AI provider credentials, defaults, MCP connectors, and usage audit are not
 * a routable workspace — they live in the Settings modal's AI section
 * (`src/admin/modals/Settings/sections/AiSection.tsx`), gated by
 * `ai.providers.manage` (or `ai.audit.read` for the read-only audit tab).
 */
export type AdminWorkspace =
  | 'dashboard'
  | 'site'
  | 'pluginPage'
  | 'account'
