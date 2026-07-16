import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

export interface StudioViteConfigOptions {
  /** Project root — same root that owns `.studio/daemon.json`
   * (ADR-0012). The generated config lives under
   * `<projectRoot>/.studio/vite/`, NOT inside the file-folder itself. */
  projectRoot: string;
  /** Absolute path to the file-folder being served (has its own,
   * untouched `vite.config.ts`). */
  fileFolderRoot: string;
  /** Used only to name the generated file uniquely per file-folder. */
  fileFolderName: string;
}

/**
 * ADR-0016 addendum / P2 WS-A daemon boot hook: writes an ephemeral,
 * daemon-generated Vite config that `mergeConfig`s a file-folder's OWN
 * `vite.config.ts` with the source-uid plugin + bridge injection, WITHOUT
 * the file-folder ever gaining an `@ccs/*` dependency (the P0 standalone
 * contract — `templates/file-app`/`files/<name>` package.json stays at
 * zero `@ccs/*` deps forever; see `standalone-contract.test.ts`).
 *
 * Design decisions (called out for the phase report):
 *  - The generated file lives at `<projectRoot>/.studio/vite/<name>.studio-config.mjs`
 *    — project-root-level `.studio/`, mirroring the ADR-0012 precedent that
 *    this directory holds daemon-owned ephemeral runtime files (ports/pids
 *    for `.studio/daemon.json`; here, a regenerated-every-boot config for
 *    Vite). It is NOT the file-folder's own `.studio/canvas.json` spatial
 *    metadata and never affects git history of the file-folder (playbook
 *    §0: ".studio/canvas.json... never affects app runtime" — this file is
 *    a build-tool input, deliberately kept OUT of any file-folder to avoid
 *    even appearing to blur that line). Regenerated fresh on every daemon
 *    start; safe to gitignore/delete.
 *  - `@ccs/vite-plugin-source-uid` and `@ccs/bridge` are resolved via
 *    `require.resolve()` FROM THE DAEMON'S OWN process (both are real
 *    dependencies of `@ccs/sync-daemon`) and embedded as ABSOLUTE file
 *    paths in the generated config's import statements — NOT bare
 *    specifiers. This makes the generated file's location on disk
 *    irrelevant to whether those imports resolve (no reliance on Node
 *    walking up to find a monorepo `node_modules` from wherever `.studio/`
 *    happens to sit). SCOPE NOTE: `@babel/core`/`@ccs/protocol` etc. (the
 *    *transitive* deps of those two packages) are still resolved the
 *    normal way by Node once the generated config is loaded, which DOES
 *    currently rely on `.studio/` living inside this monorepo (so walking
 *    up finds the root `node_modules`) — true for every `projectRoot` this
 *    codebase supports today (P1's daemon only ever opens `files/*` inside
 *    this same repo; see `vite-orchestrator.test.ts`'s `files/demo`
 *    fixture). A future out-of-monorepo project root (Phase 6+) would need
 *    a different resolution strategy — out of this worker's scope, flagged
 *    here rather than silently assumed away.
 *  - `server.fs.allow` is widened to the two packages' directories so
 *    Vite's dev server permits the bridge's `/@fs/`-served script (file-app
 *    `files/<name>` is its own standalone npm project with its own
 *    package.json, so Vite doesn't otherwise infer the monorepo as an
 *    allowed workspace root).
 *  - §6 blocker #1: `resolve.alias` maps the bare specifier `design-system`
 *    (and its sibling `design-system/dist/index.css`) to the BUILT
 *    `<projectRoot>/design-system/dist/*` files. A file-folder has ZERO
 *    `@ccs/*`-style deps (P0 standalone contract) and no `design-system`
 *    dependency either, so `import ... from 'design-system'` (written by
 *    insert-node) is otherwise unresolvable and crashes the frame. The path
 *    is derived the SAME deterministic way `token-rebuild.ts`'s
 *    `tokensJsPath` and `watcher.ts`'s `watchDesignSystem` already resolve
 *    the DS repo (`join(projectRoot, 'design-system', ...)`) — `projectRoot`
 *    is a daemon-boot-time option, never a value carried on a `CanvasOp` or
 *    any wire message, so this is not an injection surface. `dist` is also
 *    added to `server.fs.allow` so Vite actually serves those files.
 *  - The bridge is injected via `transformIndexHtml`, referencing the
 *    bridge entry by absolute path through Vite's `/@fs/` convention, so
 *    the file-app's own `index.html`/`package.json` need no changes and no
 *    `@ccs/*` dependency at all.
 */
export async function writeStudioViteConfig(options: StudioViteConfigOptions): Promise<string> {
  const pluginEntry = require.resolve('@ccs/vite-plugin-source-uid');
  const bridgeEntry = require.resolve('@ccs/bridge');
  const viteEntry = require.resolve('vite');
  const userConfigPath = join(options.fileFolderRoot, 'vite.config.ts');

  const configDir = join(options.projectRoot, '.studio', 'vite');
  await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, `${options.fileFolderName}.studio-config.mjs`);

  const bridgeEntryUrlPath = bridgeEntry.split('\\').join('/');

  // §6 blocker #1 — daemon-derived (NOT wire-controlled), same convention as
  // `token-rebuild.ts`'s `tokensJsPath` / `watcher.ts`'s `watchDesignSystem`.
  const designSystemDistDir = join(options.projectRoot, 'design-system', 'dist');
  const designSystemIndexJs = join(designSystemDistDir, 'index.js');
  const designSystemIndexCss = join(designSystemDistDir, 'index.css');

  const source = `// AUTO-GENERATED by @ccs/sync-daemon (writeStudioViteConfig) — do not edit by
// hand, regenerated every daemon start. Layers @ccs/vite-plugin-source-uid +
// the bridge injection onto this file-folder's OWN vite.config.ts, studio
// dev mode ONLY (ADR-0016 addendum). The file-folder itself has ZERO
// @ccs/* dependencies — see the P0 standalone contract.
import { mergeConfig } from ${JSON.stringify(viteEntry)};
import userConfig from ${JSON.stringify(userConfigPath)};
import { sourceUidPlugin } from ${JSON.stringify(pluginEntry)};

const BRIDGE_ENTRY_URL_PATH = ${JSON.stringify(bridgeEntryUrlPath)};

// transformIndexHtml is a PLUGIN hook, not a top-level UserConfig field —
// it must live inside a plugin object or Vite silently never calls it.
const bridgeInjectPlugin = {
  name: 'ccs:bridge-inject',
  transformIndexHtml: {
    order: 'post',
    handler(html) {
      const script =
        '<script type="module">' +
        'import { installBridge } from "/@fs/' + BRIDGE_ENTRY_URL_PATH + '";' +
        'installBridge();' +
        '</script>';
      return html.includes('</body>') ? html.replace('</body>', script + '</body>') : html + script;
    },
  },
};

/** @type {import('vite').UserConfig} */
const studioOverlay = {
  plugins: [sourceUidPlugin({ enabled: true }), bridgeInjectPlugin],
  resolve: {
    alias: {
      // §6 blocker #1: a file-folder has no \`design-system\` dependency of
      // its own (P0 standalone contract) — this maps the bare specifier
      // insert-node writes to the DS's BUILT dist output so the frame can
      // actually resolve it. The longer, more-specific CSS alias must be
      // registered before the bare "design-system" one below (Vite/esbuild
      // resolve aliases in order, and the shorter key would otherwise win).
      'design-system/dist/index.css': ${JSON.stringify(designSystemIndexCss)},
      'design-system': ${JSON.stringify(designSystemIndexJs)},
    },
  },
  server: {
    fs: {
      // Explicitly setting \`fs.allow\` replaces Vite's own auto-detected
      // default (normally the file-folder's own project root) rather than
      // extending it — so the file-folder root itself must be included
      // here too, or Vite 403s the file-folder's own files.
      allow: [
        ${JSON.stringify(options.fileFolderRoot)},
        ${JSON.stringify(dirname(bridgeEntry))},
        ${JSON.stringify(dirname(pluginEntry))},
        ${JSON.stringify(designSystemDistDir)},
      ],
    },
  },
};

export default mergeConfig(userConfig, studioOverlay);
`;

  await writeFile(configPath, source, 'utf8');
  return configPath;
}
