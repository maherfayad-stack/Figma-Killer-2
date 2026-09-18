/**
 * runtimeConfig — the shape of `virtual:studio-runtime`, the module
 * `vitePlugin.ts` injects into a scaffolded workspace's entry so the in-frame
 * runtime (L4, not yet built — see `STUDIO-LIVE-CANVAS-PLAN.md`'s Track L)
 * has, at boot, the two facts it cannot discover on its own from inside the
 * iframe: which project it belongs to, and which parent origin is allowed to
 * `postMessage` it commands.
 *
 * TypeBox, not a hand-rolled interface, because this shape crosses a real
 * boundary: `vitePlugin.ts` reads it out of `process.env` (untyped strings)
 * and serializes it into generated source the workspace's OWN Vite/Node
 * process evaluates — a different process, and eventually a different
 * origin, than the one that set the env vars. Validate at that boundary,
 * trust it once it's parsed, same as every other boundary in this codebase.
 */
import { Type, type Static } from '@sinclair/typebox'

export const STUDIO_PROJECT_KEY_ENV = 'STUDIO_PROJECT_KEY'
export const STUDIO_PARENT_ORIGIN_ENV = 'STUDIO_PARENT_ORIGIN'

export const StudioRuntimeConfigSchema = Type.Object({
  /** Identifies this workspace to the parent Studio window — `EditorBridgeScope`'s `site:${projectKey}` half, once L4 wires the bridge. */
  projectKey: Type.String(),
  /**
   * The ONLY origin the in-frame runtime may accept a `postMessage` command
   * from, and the only one it targets its own events at. `null` when L1/L2
   * have not set it yet (today, always — Track L1/L2 are what make this a
   * real security boundary; until then this is a placeholder, not
   * enforcement — see this module's own `STATE.md` handoff for the exact
   * caveat `security-guard` still needs to sign off on).
   */
  parentOrigin: Type.Union([Type.String(), Type.Null()]),
  /** The DOM attribute `idStamp.ts` writes and `liveNodeResolve.ts` reads back. A config field, not a hardcoded literal on either side, so the two can be kept in sync from one place if it ever needs to change. */
  nodeIdAttr: Type.String(),
}, { additionalProperties: false })

export type StudioRuntimeConfig = Static<typeof StudioRuntimeConfigSchema>

/**
 * Reads the runtime config from the workspace process's own environment.
 * Never throws: a missing/invalid env var degrades to `null`/a safe default
 * rather than failing the whole dev server boot over a config the runtime
 * bridge doesn't exist to consume yet (L4).
 */
export function readStudioRuntimeConfigFromEnv(
  env: Record<string, string | undefined>,
  nodeIdAttr: string,
): StudioRuntimeConfig {
  const projectKey = env[STUDIO_PROJECT_KEY_ENV]
  const parentOrigin = env[STUDIO_PARENT_ORIGIN_ENV]
  return {
    projectKey: typeof projectKey === 'string' && projectKey.length > 0 ? projectKey : 'unknown',
    parentOrigin: typeof parentOrigin === 'string' && parentOrigin.length > 0 ? parentOrigin : null,
    nodeIdAttr,
  }
}
