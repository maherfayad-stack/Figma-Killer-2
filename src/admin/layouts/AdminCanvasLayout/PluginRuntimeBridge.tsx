/**
 * PluginRuntimeBridge — headless mount point for the editor-plugin runtime.
 *
 * Isolated into its own file (and, via `AdminCanvasLayout`'s `lazy()` call,
 * its own chunk) so that a Studio-mode session that never opens
 * Settings → Plugins doesn't pay for either of `useInstalledEditorPlugins`'s
 * costs:
 *
 *   1. The `GET /admin/api/cms/plugins` DB round trip it fires on mount
 *      (`activateInstalledEditorPlugins` → `listCmsPlugins`).
 *   2. Its static dependency graph — `editorPluginLoader`, the core plugin
 *      runtime (`@core/plugins/runtime`), the canvas module-pack component
 *      factory, and the Dashboard widget-icon resolver — none of which
 *      Studio uses (Studio has no toolbar/dashboard/canvas plugin
 *      integrations; see `docs/features/plugin-system.md`).
 *
 * CMS mode renders this unconditionally on every mount (matching prior
 * behavior exactly); Studio mode renders it only while Settings → Plugins
 * is the open section, where install/enable/disable must still activate a
 * plugin's editor entrypoint. See `pluginRuntimeNeeded` in
 * `AdminCanvasLayout.tsx`.
 */
import { useInstalledEditorPlugins } from '@admin/pages/plugins/hooks/useInstalledEditorPlugins'
import { usePluginEventBridge } from '@admin/pages/plugins/hooks/usePluginEventBridge'

interface PluginRuntimeBridgeProps {
  enabled: boolean
}

export function PluginRuntimeBridge({ enabled }: PluginRuntimeBridgeProps) {
  useInstalledEditorPlugins(enabled)
  // Mount the SSE bridge ONCE per admin tab — gives toasts on plugin
  // crashes from any route, drives the red dot on the Plugins nav link,
  // and keeps the open Plugins page list refreshed.
  usePluginEventBridge(enabled)
  return null
}
