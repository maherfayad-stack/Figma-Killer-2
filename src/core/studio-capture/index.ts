/**
 * `@core/studio-capture` — the shared contract for headless agent capture
 * (`/admin/agent-capture`). Imported by BOTH the server driver
 * (`server/ai/mcp/capture/`) and the browser capture entry
 * (`src/admin/agentCapture/`).
 *
 *   - `captureWire.ts` — mount/settle/rasterise: the payload the page renders
 *     from and the readiness report the driver reads back. See its doc for the
 *     two hops.
 *   - `frameInspectWire.ts` — the second contract: ask a SETTLED frame a
 *     question (computed styles, rendered geometry) instead of photographing
 *     it.
 *   - `frameInspector.ts` — the one implementation of that read, run by the
 *     capture page AND by the live editor canvas so the headless answer and
 *     the live-tab fallback cannot drift.
 */
export * from './captureWire'
export * from './frameInspectWire'
export * from './frameInspector'
