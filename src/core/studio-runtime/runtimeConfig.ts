/**
 * runtimeConfig — the shape of `virtual:studio-runtime`, the module
 * `vitePlugin.ts` injects into a scaffolded workspace's entry so the in-frame
 * runtime has, at boot, the two facts it cannot discover on its own from
 * inside the iframe: which project it belongs to, and which parent origins
 * are allowed to `postMessage` it commands.
 *
 * TypeBox, not a hand-rolled interface, because this shape crosses a real
 * boundary: `vitePlugin.ts` reads it out of `process.env` (untyped strings)
 * and serializes it into generated source the workspace's OWN Vite/Node
 * process evaluates — a different process, and a different origin, than the
 * one that set the env vars. Validate at that boundary, trust it once it's
 * parsed, same as every other boundary in this codebase.
 */
import { Type, type Static } from '@sinclair/typebox'

export const STUDIO_PROJECT_KEY_ENV = 'STUDIO_PROJECT_KEY'
/**
 * Comma-separated. `devServer.ts` sets it to `ServerConfig.liveFrameAncestors`
 * — every origin the live listener lets frame it — and the shell's `main.jsx`
 * picks the one that actually framed it via `resolveParentOrigin`. A LIST,
 * not one origin, because the editor has several legitimate origins on one
 * machine (Vite's dev ports, the admin server's own port, a configured
 * `PUBLIC_ORIGIN`) and the runtime cannot know which one opened it until it
 * looks at `document.referrer`.
 */
export const STUDIO_PARENT_ORIGINS_ENV = 'STUDIO_PARENT_ORIGINS'

export const StudioRuntimeConfigSchema = Type.Object({
  /** Identifies this workspace to the parent Studio window — `EditorBridgeScope`'s `site:${projectKey}` half. */
  projectKey: Type.String(),
  /**
   * The ONLY origins the in-frame runtime may accept a `postMessage` command
   * from; the one that actually framed it becomes the single origin its own
   * events are targeted at (`resolveParentOrigin`). Empty when this process
   * was not spawned by Studio (a bare `npm run dev`, `vite build`) — then no
   * bridge boots at all.
   */
  parentOrigins: Type.Array(Type.String()),
  /** The DOM attribute `idStamp.ts` writes and `liveNodeResolve.ts` reads back. A config field, not a hardcoded literal on either side, so the two can be kept in sync from one place if it ever needs to change. */
  nodeIdAttr: Type.String(),
}, { additionalProperties: false })

export type StudioRuntimeConfig = Static<typeof StudioRuntimeConfigSchema>

/**
 * Reads the runtime config from the workspace process's own environment.
 * Never throws: a missing/invalid env var degrades to an empty list / a safe
 * default rather than failing the whole dev server boot.
 */
export function readStudioRuntimeConfigFromEnv(
  env: Record<string, string | undefined>,
  nodeIdAttr: string,
): StudioRuntimeConfig {
  const projectKey = env[STUDIO_PROJECT_KEY_ENV]
  const parentOrigins = (env[STUDIO_PARENT_ORIGINS_ENV] ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  return {
    projectKey: typeof projectKey === 'string' && projectKey.length > 0 ? projectKey : 'unknown',
    parentOrigins,
    nodeIdAttr,
  }
}
