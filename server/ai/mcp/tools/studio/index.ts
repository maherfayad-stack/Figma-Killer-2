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
import { studioDesignReferenceMcpTools } from './designReferenceTools'
import { studioDesignVariableMcpTools } from './designVariableTools'
import { studioBrowserBridgeMcpTools } from './browserBridgeTools'
import { studioPackageDocMcpTools } from './packageDocTools'
import { studioFrameworkTokenMcpTools } from './frameworkTokenTools'
import { studioComponentCatalogMcpTools } from './componentCatalogTools'
import { studioFigmaBindingMcpTools } from './figmaBindingTools'
import { studioRemoteAssetMcpTools } from './remoteAssetTools'
import { studioScreenshotTool } from './screenshot'
import { studioCompareMcpTools } from './compare'
import { studioMeasureReferenceMcpTools } from './measureReference'
import { studioExtractReferenceAssetMcpTools } from './extractReferenceAsset'
import { studioQualityCheckMcpTools } from './qualityCheck'
import { studioTypecheckMcpTools } from './typecheck'

export const studioMcpTools: AiTool[] = [
  studioScreenshotTool,
  ...studioCompareMcpTools,
  ...studioMeasureReferenceMcpTools,
  ...studioQualityCheckMcpTools,
  ...studioTypecheckMcpTools,
  ...studioExtractReferenceAssetMcpTools,
  ...studioProjectMcpTools,
  ...studioEditMcpTools,
  studioFidelityReportTool,
  ...studioExportMcpTools,
  ...studioReferenceMcpTools,
  ...studioDiffMcpTools,
  ...studioDesignReferenceMcpTools,
  ...studioDesignVariableMcpTools,
  ...studioBrowserBridgeMcpTools,
  ...studioPackageDocMcpTools,
  ...studioFrameworkTokenMcpTools,
  ...studioComponentCatalogMcpTools,
  ...studioFigmaBindingMcpTools,
  ...studioRemoteAssetMcpTools,
]
