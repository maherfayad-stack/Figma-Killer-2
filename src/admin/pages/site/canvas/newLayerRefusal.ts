/**
 * newLayerRefusal (PA-3) — the one sentence a placed gesture says when the
 * parent cannot take an absolute child: K6's remedy, shared by the draw tool
 * and the Assets-panel drops (the OS file drop words the same refusal itself,
 * with the parent's tag, in `canvasFileDrop.ts`).
 */
import { isPlatformMac } from '@admin/spotlight/keybindings'
import type { NewLayerPlacement } from './canvasNewLayerPlacement'

type Refused = Extract<NewLayerPlacement, { kind: 'refused' }>

export function newLayerRefusalToast(what: string, reason: Refused['reason']) {
  const key = isPlatformMac() ? '⌘' : 'Ctrl'
  return {
    kind: 'warning' as const,
    title: `${what} not added`,
    body:
      reason === 'static-parent'
        ? `${key} places a layer at the pointer, and this one is position: static. Make it position: relative.`
        : 'Studio cannot measure where that layer would sit in this frame. Switch the board to the editable canvas.',
    location: 'site-editor' as const,
  }
}
