/**
 * The model ONE chat turn runs on — `modelRouting.ts`'s table applied to a
 * real turn: classify the prompt (`turnRouting.ts`'s `classifyTurn`, the same
 * classifier the CLI's effort routing uses), map the shape to a role, and ask
 * the table, the conversation's model source and the key's model list.
 *
 * Called by the chat handler before anything is spent, for every provider:
 * the answer is also what the turn's telemetry records, so a CLI turn is
 * measured by role too even though it is never routed.
 */
import type { AiProvider, AiResolvedCredential } from '../drivers/types'
import type { ConversationRecord } from '../conversations/types'
import { readTurnWriteLog } from '../../handlers/studio/turnWriteLog'
import { studioAgentUserKey } from '../../handlers/studio/agentUserScope'
import { classifyTurn, type TurnShape } from './turnRouting'
import { roleForTurn, routeModel, type ModelRoute } from './modelRouting'
import { availableModelIds } from './modelAvailability'

export interface ChatTurnModel extends ModelRoute {
  readonly shape: TurnShape
}

export async function routeChatTurnModel(params: {
  readonly driver: AiProvider
  readonly credentials: AiResolvedCredential
  readonly conversation: Pick<ConversationRecord, 'modelId' | 'modelSource'>
  readonly userText: string
  readonly attachmentCount: number
  /** The validated open project, or `null`. Read for the previous turn's writes only. */
  readonly workspaceDir: string | null
  readonly userId: string
  readonly fidelityMode: string | undefined
  readonly signal: AbortSignal
}): Promise<ChatTurnModel> {
  const { driver, credentials, conversation, workspaceDir } = params
  const previousTurnWriteCount = workspaceDir ? readTurnWriteLog(workspaceDir, studioAgentUserKey(params.userId)).length : 0
  const { shape } = classifyTurn({ prompt: params.userText, attachmentCount: params.attachmentCount, previousTurnWriteCount })
  const role = roleForTurn(shape, params.fidelityMode)
  // Only a default Anthropic conversation can be routed at all; asking the
  // catalogue for any other turn would be a round trip with no use.
  const needsCatalogue = conversation.modelSource === 'default' && credentials.providerId === 'anthropic'
  const available = needsCatalogue ? await availableModelIds(driver, credentials, params.signal) : null
  const route = routeModel({
    providerId: credentials.providerId,
    modelId: conversation.modelId,
    modelSource: conversation.modelSource,
    role,
    availableModelIds: available,
  })
  return { ...route, shape }
}
