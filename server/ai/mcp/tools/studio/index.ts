/**
 * Barrel — every studio MCP tool (WS-9), composed into `../../registry.ts`.
 *
 * The file-authoring tools (`./fileWriteTools.ts`) are deliberately NOT here:
 * they write only into the project a chat turn is about, and no external
 * connector is ever bound to one. The in-canvas agent's HTTP surface composes
 * them in directly (`server/ai/tools/studio/index.ts`).
 */
import type { AiTool } from '../../../runtime/types'
import { studioProjectMcpTools } from './projectTools'
import { studioFileReadMcpTools } from './fileReadTools'
import { studioEditMcpTools } from './editTools'
import { studioFidelityReportTool } from './fidelityReport'
import { studioExportMcpTools } from './exportFrames'
import { studioReferenceMcpTools } from './referenceRender'
import { studioDiffMcpTools } from './diffFrames'
import { studioDesignReferenceMcpTools } from './designReferenceTools'
import { studioDesignVariableMcpTools } from './designVariableTools'
import { studioImportFigmaFrameMcpTools } from './importFigmaFrame'
import { studioUploadAssetMcpTools } from './uploadAssetTool'
import { studioFrameAxesMcpTools } from './frameAxesTools'
import { studioComputedStylesMcpTools } from './computedStyles'
import { studioMeasureElementMcpTools } from './measureElement'
import { studioPackageDocMcpTools } from './packageDocTools'
import { studioProjectTokenMcpTools } from './projectTokenTools'
import { studioComponentCatalogMcpTools } from './componentCatalogTools'
import { studioComponentSnippetMcpTools } from './componentSnippetTool'
import { studioSetTokensMcpTools } from './setTokensTool'
import { studioArrangeFramesMcpTools } from './arrangeFramesTool'
import { studioFigmaBindingMcpTools } from './figmaBindingTools'
import { studioRemoteAssetMcpTools } from './remoteAssetTools'
import { studioScreenshotTool } from './screenshot'
import { studioCompareMcpTools } from './compare'
import { studioMeasureReferenceMcpTools } from './measureReference'
import { studioExtractReferenceAssetMcpTools } from './extractReferenceAsset'
import { studioQualityCheckMcpTools } from './qualityCheck'
import { studioVariantMcpTools } from './variantTools'
import { studioTypecheckMcpTools } from './typecheck'
import { studioCommentMcpTools } from './commentTools'
import { studioGitMcpTools } from './gitTools'
import { studioPageDiagnosticsMcpTools } from './pageDiagnostics'

export const studioMcpTools: AiTool[] = [
  studioScreenshotTool,
  ...studioCompareMcpTools,
  ...studioMeasureReferenceMcpTools,
  ...studioMeasureElementMcpTools,
  ...studioQualityCheckMcpTools,
  ...studioVariantMcpTools,
  ...studioTypecheckMcpTools,
  ...studioExtractReferenceAssetMcpTools,
  ...studioProjectMcpTools,
  ...studioFileReadMcpTools,
  ...studioEditMcpTools,
  ...studioArrangeFramesMcpTools,
  studioFidelityReportTool,
  ...studioExportMcpTools,
  ...studioReferenceMcpTools,
  ...studioDiffMcpTools,
  ...studioDesignReferenceMcpTools,
  ...studioDesignVariableMcpTools,
  ...studioImportFigmaFrameMcpTools,
  ...studioUploadAssetMcpTools,
  ...studioFrameAxesMcpTools,
  ...studioComputedStylesMcpTools,
  ...studioPackageDocMcpTools,
  ...studioProjectTokenMcpTools,
  ...studioSetTokensMcpTools,
  ...studioComponentCatalogMcpTools,
  ...studioComponentSnippetMcpTools,
  ...studioFigmaBindingMcpTools,
  ...studioRemoteAssetMcpTools,
  ...studioCommentMcpTools,
  ...studioGitMcpTools,
  ...studioPageDiagnosticsMcpTools,
]
