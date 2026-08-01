/**
 * Barrel — every studio MCP tool (WS-9), composed into `../../registry.ts`.
 */
import type { AiTool } from '../../../runtime/types'
import { studioProjectMcpTools } from './projectTools'
import { studioEditMcpTools } from './editTools'
import { studioFidelityReportTool } from './fidelityReport'
import { studioExportMcpTools } from './exportFrames'
import { studioReferenceMcpTools } from './referenceRender'
import { studioDiffMcpTools } from './diffFrames'
import { studioBrowserBridgeMcpTools } from './browserBridgeTools'

export const studioMcpTools: AiTool[] = [
  ...studioProjectMcpTools,
  ...studioEditMcpTools,
  studioFidelityReportTool,
  ...studioExportMcpTools,
  ...studioReferenceMcpTools,
  ...studioDiffMcpTools,
  ...studioBrowserBridgeMcpTools,
]
