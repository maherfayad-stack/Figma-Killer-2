/**
 * CanvasArmedToolLayer — the one surface `CanvasRoot` mounts while a tool is
 * armed: the box tools' draw layer (R / O / T / F, P5-E) or the pen's
 * (P, P5-D). One lazy boundary, one mount point: the two layers are the same
 * kind of thing — parent-document chrome that owns the pointer over the whole
 * canvas while armed, and adds nothing to any frame's page.
 */
import type { RefObject } from 'react'
import { isVectorTool, type ArmedTool } from './canvasDrawTool'
import { CanvasDrawToolLayer } from './CanvasDrawToolLayer'
import { CanvasPenToolLayer } from './CanvasPenToolLayer'

interface CanvasArmedToolLayerProps {
  tool: ArmedTool
  transformLayerRef: RefObject<HTMLDivElement | null>
}

export function CanvasArmedToolLayer({ tool, transformLayerRef }: CanvasArmedToolLayerProps) {
  if (isVectorTool(tool)) return <CanvasPenToolLayer transformLayerRef={transformLayerRef} />
  return <CanvasDrawToolLayer tool={tool} transformLayerRef={transformLayerRef} />
}
