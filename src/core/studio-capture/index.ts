/**
 * `@core/studio-capture` — the shared contract for headless agent capture
 * (`/admin/agent-capture`). Imported by BOTH the server driver
 * (`server/ai/mcp/capture/`) and the browser capture entry
 * (`src/admin/agentCapture/`); see `captureWire.ts` for the two hops.
 */
export * from './captureWire'
