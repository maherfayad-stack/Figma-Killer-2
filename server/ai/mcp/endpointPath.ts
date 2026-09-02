/**
 * The one path Studio's MCP server listens on. Kept in its own tiny,
 * SDK-free module so an importer that only needs the PATH — not the
 * transport, which imports `@modelcontextprotocol/sdk` at module scope
 * (`transports/http.ts`) — doesn't pull the SDK in transitively.
 * `server/ai/drivers/claudeCli.ts` is exactly this case: it builds a
 * `--mcp-config` URL for a subprocess, it doesn't speak MCP itself.
 */
export const MCP_ENDPOINT_PATH = '/_studio/mcp'
