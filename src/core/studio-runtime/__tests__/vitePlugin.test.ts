/**
 * vitePlugin — unit tests for the `studioRuntimeIdPlugin()` two-plugin split
 * (live-08).
 *
 * `apply: 'serve'` is a PLUGIN-level field in the installed Vite — it
 * disables `resolveId`/`load` along with `transform`, not just `transform`.
 * Since `main.jsx` now imports `virtual:studio-runtime` unconditionally
 * (including at `vite build` time — "Download the code", preview deploys),
 * the config-resolving half of this plugin must run unconditionally too,
 * while the id-stamping half must stay dev-server-only. These tests pin that
 * split so a future edit cannot silently re-merge the two hooks back into one
 * `apply: 'serve'`-scoped plugin object.
 */
import { describe, expect, it } from 'bun:test'
import type { Plugin } from 'vite'
import { studioRuntimeIdPlugin, STUDIO_PARENT_ORIGIN_ENV, STUDIO_PROJECT_KEY_ENV } from '../vitePlugin'

/** Test-only accessor — Vite's hook fields are typed as `ObjectHook<Fn>`, a `Fn | { handler: Fn }` union, but every hook in this plugin is authored as a bare function, never the object form. */
function callHook<T>(hook: unknown, ...args: unknown[]): T {
  return (hook as (...a: unknown[]) => T)(...args)
}

describe('studioRuntimeIdPlugin', () => {
  it('returns exactly two plugin objects', () => {
    const plugins = studioRuntimeIdPlugin()
    expect(Array.isArray(plugins)).toBe(true)
    expect(plugins.length).toBe(2)
  })

  it('the config plugin carries no `apply` restriction, so it runs during `vite build` too', () => {
    const [configPlugin] = studioRuntimeIdPlugin()
    expect(configPlugin!.name).toBe('studio-runtime-config')
    expect(configPlugin!.apply).toBeUndefined()
  })

  it('the config plugin resolves virtual:studio-runtime to the internal id, and leaves everything else alone', () => {
    const [configPlugin] = studioRuntimeIdPlugin()
    expect(callHook<string | undefined>(configPlugin!.resolveId, 'virtual:studio-runtime')).toBe('\0virtual:studio-runtime')
    expect(callHook<string | undefined>(configPlugin!.resolveId, './App.jsx')).toBeUndefined()
  })

  it('the config plugin loads STUDIO_RUNTIME_CONFIG from process.env, matching readStudioRuntimeConfigFromEnv', () => {
    const [configPlugin] = studioRuntimeIdPlugin()
    const originalKey = process.env[STUDIO_PROJECT_KEY_ENV]
    const originalOrigin = process.env[STUDIO_PARENT_ORIGIN_ENV]
    try {
      process.env[STUDIO_PROJECT_KEY_ENV] = 'demo-project'
      process.env[STUDIO_PARENT_ORIGIN_ENV] = 'https://studio.example.com'

      const source = callHook<string | undefined>(configPlugin!.load, '\0virtual:studio-runtime')
      expect(source).toContain('export const STUDIO_RUNTIME_CONFIG =')
      expect(source).toContain('"projectKey":"demo-project"')
      expect(source).toContain('"parentOrigin":"https://studio.example.com"')
      expect(source).toContain('"nodeIdAttr":"data-node-id"')

      expect(callHook<string | undefined>(configPlugin!.load, './App.jsx')).toBeUndefined()
    } finally {
      if (originalKey === undefined) delete process.env[STUDIO_PROJECT_KEY_ENV]
      else process.env[STUDIO_PROJECT_KEY_ENV] = originalKey
      if (originalOrigin === undefined) delete process.env[STUDIO_PARENT_ORIGIN_ENV]
      else process.env[STUDIO_PARENT_ORIGIN_ENV] = originalOrigin
    }
  })

  it('the config plugin degrades to inert data when the env vars are unset — the "vite build" / "npm run dev" case', () => {
    const [configPlugin] = studioRuntimeIdPlugin()
    const originalKey = process.env[STUDIO_PROJECT_KEY_ENV]
    const originalOrigin = process.env[STUDIO_PARENT_ORIGIN_ENV]
    try {
      delete process.env[STUDIO_PROJECT_KEY_ENV]
      delete process.env[STUDIO_PARENT_ORIGIN_ENV]

      const source = callHook<string | undefined>(configPlugin!.load, '\0virtual:studio-runtime')
      expect(source).toContain('"projectKey":"unknown"')
      expect(source).toContain('"parentOrigin":null')
    } finally {
      if (originalKey === undefined) delete process.env[STUDIO_PROJECT_KEY_ENV]
      else process.env[STUDIO_PROJECT_KEY_ENV] = originalKey
      if (originalOrigin === undefined) delete process.env[STUDIO_PARENT_ORIGIN_ENV]
      else process.env[STUDIO_PARENT_ORIGIN_ENV] = originalOrigin
    }
  })

  it('the id-stamp plugin is dev-server-only (`apply: \'serve\'`) and stamps host JSX elements unchanged from before the split', () => {
    const [, idStampPlugin] = studioRuntimeIdPlugin()
    expect(idStampPlugin!.name).toBe('studio-runtime-id-plugin')
    expect(idStampPlugin!.apply).toBe('serve')
    expect(idStampPlugin!.enforce).toBe('pre')

    // Simulate `configResolved` setting the workspace root, same as Vite would.
    callHook(idStampPlugin!.configResolved, { root: '/workspace' })

    const code = 'export default function Home() {\n  return <div>hi</div>\n}\n'
    const result = callHook<{ code: string; map: null } | undefined>(idStampPlugin!.transform, code, '/workspace/pages/Home.tsx')
    expect(result?.code).toContain('data-node-id="pages/Home.tsx:2:11"')
    expect(result?.map).toBeNull()
  })

  it('the id-stamp plugin still excludes the prototype shell directory and node_modules, unchanged from before the split', () => {
    const [, idStampPlugin] = studioRuntimeIdPlugin()
    callHook(idStampPlugin!.configResolved, { root: '/workspace' })

    const code = 'export default function Shell() {\n  return <div>shell</div>\n}\n'
    expect(callHook(idStampPlugin!.transform, code, '/workspace/prototype/App.jsx')).toBeUndefined()
    expect(callHook(idStampPlugin!.transform, code, '/workspace/node_modules/pkg/index.jsx')).toBeUndefined()
    expect(callHook(idStampPlugin!.transform, code, '/workspace/pages/Home.css')).toBeUndefined()
  })

  it('the call site\'s `plugins: [react(), studioRuntimeIdPlugin()]` shape (VITE_CONFIG\'s own template text) needs no edit — a nested array of two named plugins, which Vite/Rollup\'s own `plugins` option flattens one level (documented in `UserConfig.plugins`\'s `PluginOption[]` type; not re-exercised here, since doing so would require Vite\'s own container)', () => {
    const react = { name: 'vite:react' } as unknown as Plugin
    const configLike: Array<Plugin | Plugin[]> = [react, studioRuntimeIdPlugin()]
    expect(configLike[1]).toBeInstanceOf(Array)
    expect((configLike[1] as Plugin[]).map((p) => p.name)).toEqual(['studio-runtime-config', 'studio-runtime-id-plugin'])
  })
})
