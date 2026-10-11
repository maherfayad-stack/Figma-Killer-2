import { safeParseJson } from '@core/utils/jsonValidate'
import {
  LiveClientMessageSchema,
  LiveServerMessageSchema,
  type LiveClientMessage,
  type LiveServerMessage,
} from './protocol'

/** Validates one inbound text frame on the server. `null` means "drop and count it". */
export function parseLiveClientMessage(raw: string): LiveClientMessage | null {
  const result = safeParseJson(raw, LiveClientMessageSchema)
  return result.ok ? result.value : null
}

/** Validates one inbound text frame on the client. */
export function parseLiveServerMessage(raw: string): LiveServerMessage | null {
  const result = safeParseJson(raw, LiveServerMessageSchema)
  return result.ok ? result.value : null
}

export function encodeLiveMessage(message: LiveClientMessage | LiveServerMessage): string {
  return JSON.stringify(message)
}
