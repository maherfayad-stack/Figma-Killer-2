/**
 * Panels commands — §4.4 of the Command Spotlight master plan.
 *
 * Toggle/open editor side-panels, cycle panel focus, toggle the code editor.
 * All gated to workspace: ['site'] since panels only exist in the site editor.
 *
 * Capability: `site.read` — every panel is a read-only UI affordance. The
 * underlying mutations the panels expose are themselves capability-gated.
 */

import type { Command } from '../types'

const PANEL_CAPABILITY = 'site.read'

export function getPanelsCommands(): Command[] {
  return [
    // ── Explorer panel ───────────────────────────────────────────────────────
    {
      id: 'panels.toggleExplorer',
      title: 'Toggle Explorer panel',
      subtitle: 'Show or hide the Explorer (boards + layers) panel',
      group: 'editor',
      iconName: 'files-stack-2-solid',
      keywords: ['panel', 'explorer', 'layers', 'boards', 'pages', 'sidebar', 'toggle'],
      workspaces: ['site'],
      capability: PANEL_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().toggleLeftSidebarPanel('explorer')
        } catch (err) {
          console.error('[spotlight] toggleLeftSidebarPanel explorer failed:', err)
        }
      },
    },

    // ── Explorer, forced open ────────────────────────────────────────────────
    {
      id: 'panels.showLayers',
      title: 'Show Layers',
      subtitle: 'Open the Explorer panel (boards + the all-pages layers tree)',
      group: 'editor',
      iconName: 'list-box-solid',
      keywords: ['panel', 'layers', 'dom', 'tree', 'explorer', 'show'],
      workspaces: ['site'],
      capability: PANEL_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().setLeftSidebarPanel('explorer')
        } catch (err) {
          console.error('[spotlight] show layers failed:', err)
        }
      },
    },

    // ── Selectors panel ──────────────────────────────────────────────────────
    {
      id: 'panels.toggleSelectors',
      title: 'Toggle Classes panel',
      subtitle: 'Show or hide the classes panel',
      group: 'editor',
      iconName: 'code',
      keywords: ['panel', 'selectors', 'css', 'classes', 'toggle'],
      workspaces: ['site'],
      capability: PANEL_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().toggleLeftSidebarPanel('selectors')
        } catch (err) {
          console.error('[spotlight] toggleLeftSidebarPanel selectors failed:', err)
        }
      },
    },

    // ── Framework panel ──────────────────────────────────────────────────────
    {
      id: 'panels.toggleFramework',
      title: 'Toggle Framework panel',
      subtitle: 'Show or hide the design-token framework panel (colors, type, space)',
      group: 'editor',
      iconName: 'colors-swatch-solid',
      keywords: ['panel', 'framework', 'colors', 'typography', 'spacing', 'tokens', 'toggle'],
      workspaces: ['site'],
      capability: PANEL_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().toggleLeftSidebarPanel('framework')
        } catch (err) {
          console.error('[spotlight] toggleLeftSidebarPanel framework failed:', err)
        }
      },
    },

    // ── Dependencies panel ───────────────────────────────────────────────────
    {
      id: 'panels.toggleDependencies',
      title: 'Toggle Dependencies panel',
      subtitle: 'Show or hide the site dependencies panel',
      group: 'editor',
      iconName: 'package-solid',
      keywords: ['panel', 'dependencies', 'packages', 'plugins', 'toggle'],
      workspaces: ['site'],
      capability: PANEL_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().toggleLeftSidebarPanel('dependencies')
        } catch (err) {
          console.error('[spotlight] toggleLeftSidebarPanel dependencies failed:', err)
        }
      },
    },

    // ── AI Assistant panel ───────────────────────────────────────────────────
    {
      id: 'panels.toggleAgent',
      title: 'Toggle AI Assistant panel',
      subtitle: 'Show or hide the AI assistant panel',
      group: 'editor',
      iconName: 'sparkles-solid',
      keywords: ['panel', 'ai', 'assistant', 'agent', 'claude', 'toggle'],
      workspaces: ['site'],
      capability: PANEL_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().toggleLeftSidebarPanel('agent')
        } catch (err) {
          console.error('[spotlight] toggleLeftSidebarPanel agent failed:', err)
        }
      },
    },

    // ── Properties panel ─────────────────────────────────────────────────────
    {
      id: 'panels.toggleProperties',
      title: 'Toggle Properties panel',
      subtitle: 'Show or hide the properties panel',
      group: 'editor',
      iconName: 'sliders-horizontal',
      keywords: ['panel', 'properties', 'inspector', 'toggle'],
      workspaces: ['site'],
      capability: PANEL_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().togglePropertiesPanel()
        } catch (err) {
          console.error('[spotlight] togglePropertiesPanel failed:', err)
        }
      },
    },

    // ── Code editor panel ────────────────────────────────────────────────────
    {
      id: 'panels.toggleCodeEditor',
      title: 'Toggle Code editor panel',
      subtitle: 'Show or hide the floating code editor',
      group: 'editor',
      iconName: 'code',
      keywords: ['panel', 'code', 'editor', 'file', 'toggle'],
      workspaces: ['site'],
      capability: PANEL_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          const store = useEditorStore.getState()
          store.setCodeEditorPanelOpen(!store.codeEditorPanelOpen)
        } catch (err) {
          console.error('[spotlight] toggleCodeEditorPanel failed:', err)
        }
      },
    },

    // ── Cycle panel focus ────────────────────────────────────────────────────
    {
      id: 'panels.cycleFocus',
      title: 'Cycle panel focus',
      subtitle: 'Move keyboard focus between canvas, layers, and properties',
      group: 'editor',
      iconName: 'arrows-horizontal',
      keywords: ['panel', 'focus', 'cycle', 'keyboard', 'navigate'],
      workspaces: ['site'],
      capability: PANEL_CAPABILITY,
      keepOpenAfterRun: false,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().cycleFocusedPanel()
        } catch (err) {
          console.error('[spotlight] cycleFocusedPanel failed:', err)
        }
      },
    },
  ]
}
