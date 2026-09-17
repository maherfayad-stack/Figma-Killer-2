/**
 * Canvas view commands — §4.2 of the master plan: switch canvas mode (select /
 * pan) and control zoom. All gated to workspace: ['site'] and capability
 * `site.read` — these are pure viewing affordances against the canvas.
 *
 * The `preview.toggle` command that used to head this list is GONE (P8): it
 * opened `PreviewOverlay`, a third preview that rendered the CMS publisher's
 * static HTML into a sandboxed iframe — neither the canvas nor the real app,
 * and the one most likely to look broken on a Studio page. The two real
 * previews are the Live canvas view and, at Tier 2, the project's own dev
 * server. The `preview.` id prefix is kept: these ids are user-facing (recent
 * commands, keybindings) and renaming them would strand both for no gain.
 */

import type { Command } from '../types'

const PREVIEW_CAPABILITY = 'site.read'

export function getPreviewCommands(): Command[] {
  return [
    // ── Select mode ──────────────────────────────────────────────────────────
    {
      id: 'preview.modeSelect',
      title: 'Switch to Select mode',
      subtitle: 'Use the pointer to select and edit layers',
      group: 'preview',
      iconName: 'pointer-solid',
      keywords: ['mode', 'select', 'pointer', 'cursor', 'canvas'],
      workspaces: ['site'],
      capability: PREVIEW_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().setCanvasMode('select')
        } catch (err) {
          console.error('[spotlight] setCanvasMode select failed:', err)
        }
      },
    },

    // ── Pan mode ─────────────────────────────────────────────────────────────
    {
      id: 'preview.modePan',
      title: 'Switch to Pan mode',
      subtitle: 'Use the hand tool to pan the canvas',
      group: 'preview',
      iconName: 'hand-grab-solid',
      keywords: ['mode', 'pan', 'hand', 'drag', 'canvas', 'scroll'],
      workspaces: ['site'],
      capability: PREVIEW_CAPABILITY,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().setCanvasMode('pan')
        } catch (err) {
          console.error('[spotlight] setCanvasMode pan failed:', err)
        }
      },
    },

    // ── Zoom in ──────────────────────────────────────────────────────────────
    {
      id: 'preview.zoomIn',
      title: 'Zoom in',
      subtitle: 'Increase canvas zoom level',
      group: 'preview',
      iconName: 'plus',
      keywords: ['zoom', 'in', 'enlarge', 'magnify', 'canvas'],
      workspaces: ['site'],
      capability: PREVIEW_CAPABILITY,
      keepOpenAfterRun: false,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().zoomIn()
        } catch (err) {
          console.error('[spotlight] zoomIn failed:', err)
        }
      },
    },

    // ── Zoom out ─────────────────────────────────────────────────────────────
    {
      id: 'preview.zoomOut',
      title: 'Zoom out',
      subtitle: 'Decrease canvas zoom level',
      group: 'preview',
      iconName: 'proportions-solid',
      keywords: ['zoom', 'out', 'shrink', 'canvas'],
      workspaces: ['site'],
      capability: PREVIEW_CAPABILITY,
      keepOpenAfterRun: false,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().zoomOut()
        } catch (err) {
          console.error('[spotlight] zoomOut failed:', err)
        }
      },
    },

    // ── Reset zoom ───────────────────────────────────────────────────────────
    {
      id: 'preview.zoomReset',
      title: 'Reset zoom to 100%',
      subtitle: 'Reset the canvas to 1:1 zoom',
      group: 'preview',
      iconName: 'laptop-solid',
      keywords: ['zoom', 'reset', '100%', 'actual size', 'canvas'],
      workspaces: ['site'],
      capability: PREVIEW_CAPABILITY,
      keepOpenAfterRun: false,
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().setZoom(1)
        } catch (err) {
          console.error('[spotlight] setZoom reset failed:', err)
        }
      },
    },
  ]
}
