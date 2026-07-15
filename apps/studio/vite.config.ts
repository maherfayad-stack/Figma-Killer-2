import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import type * as CcsTokens from '@ccs/tokens';

/**
 * `@ccs/tokens` <-> `apps/studio` integration bridge (ADR-0022 P4/P5 seam).
 *
 * CR (architecture, flagged not silently decided): `apps/studio` is a
 * browser Vite SPA (playbook §1); `@ccs/tokens`'s FROZEN catalog reads
 * (`listComponents`/`getPropSchema`/`tokensForProperty`, `packages/tokens/
 * src/catalog.ts`) are deliberately fs-touching (`readdirSync`/
 * `readFileSync`) and `parseAlmosaferTokensJs` runs on `ts-morph` — both
 * Node-only, not something a browser bundle can execute (there is no `fs`,
 * and even polyfilled it couldn't reach the real `design-system/` folder on
 * disk from inside the page). ADR-0022's own catalog.ts doc comment says
 * "P5 imports these directly; no daemon round-trip needed for reads",
 * written from the P4 side without accounting for P5 actually being a
 * client-only SPA — that assumption doesn't hold as literally written.
 *
 * Rather than silently faking this or reaching into `packages/sync-daemon`
 * (out of this phase's authorized-touch list — a real daemon control-message
 * for catalog reads is the RIGHT long-term fix and is called out as a CR in
 * this phase's report), this file runs `@ccs/tokens` ONLY inside the Vite
 * DEV SERVER's own Node process (`configureServer`, never bundled to the
 * client) and exposes it to the browser over a few tiny same-origin HTTP
 * endpoints under `/__ccs/catalog/*`. `src/engine/real-engine-api.ts`
 * fetches these. This is honest about being a DEV-ONLY bridge: it has no
 * production (statically-built, no Node dev server) code path yet — that is
 * this CR's scope, for whoever builds the Phase 6 backend / static-hosting
 * story, at which point catalog reads should probably move behind the
 * sync-daemon's control-ws instead (it is already the sole fs-reader/writer
 * everywhere else in this system).
 *
 * CR (loader detail): `@ccs/tokens` ships raw `.ts` sources with NodeNext-
 * style `./foo.js` internal specifiers (no build step, playbook convention
 * across every `@ccs/*` package). Vite's OWN config-file bundler treats
 * bare `node_modules`-resolved imports (which is what a pnpm workspace link
 * looks like) as EXTERNAL and hands them to plain Node ESM resolution —
 * which can't resolve a `.js` specifier to a sibling `.ts` file, so a
 * top-level `import ... from '@ccs/tokens'` at the TOP of this file fails
 * to even boot the dev server (`ERR_MODULE_NOT_FOUND`), even though the
 * exact same package resolves fine for ordinary application source (which
 * goes through Vite's OWN resolver/transformer, not Node's). Fix: load it
 * lazily via `server.ssrLoadModule(...)` from inside `configureServer` —
 * that path runs through Vite's dev-server module graph (same resolution
 * app code gets), sidestepping the config-loader's more restrictive path.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKENS_JS_PATH = join(HERE, '..', '..', 'design-system', 'src', 'tokens', 'tokens.js');

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function ccsCatalogBridgePlugin(): Plugin {
  let tokensModPromise: Promise<typeof CcsTokens> | undefined;

  return {
    name: 'ccs-catalog-bridge',
    configureServer(server: ViteDevServer) {
      function loadTokensMod(): Promise<typeof CcsTokens> {
        tokensModPromise ??= server.ssrLoadModule('@ccs/tokens') as Promise<typeof CcsTokens>;
        return tokensModPromise;
      }

      server.middlewares.use('/__ccs/catalog/components', (_req, res) => {
        loadTokensMod()
          .then((mod) => sendJson(res, 200, mod.listComponents()))
          .catch((err: unknown) => sendJson(res, 500, { error: String(err) }));
      });

      server.middlewares.use('/__ccs/catalog/prop-schema', (req, res) => {
        const url = new URL(req.url ?? '', 'http://ccs-internal');
        const name = url.searchParams.get('name') ?? '';
        loadTokensMod()
          .then((mod) => {
            try {
              sendJson(res, 200, mod.getPropSchema(name));
            } catch {
              // Real `getPropSchema` THROWS for an unknown component (frozen
              // ADR-0022 shape); the studio-side adapter wants a null-able
              // result instead (matches every UI call site's `?? null`
              // usage), so translate at this same boundary.
              sendJson(res, 200, null);
            }
          })
          .catch((err: unknown) => sendJson(res, 500, { error: String(err) }));
      });

      server.middlewares.use('/__ccs/catalog/tokens-for-property', (req, res) => {
        const url = new URL(req.url ?? '', 'http://ccs-internal');
        const cssProp = url.searchParams.get('cssProp') ?? '';
        loadTokensMod()
          .then((mod) => sendJson(res, 200, mod.tokensForProperty(cssProp)))
          .catch((err: unknown) => sendJson(res, 500, { error: String(err) }));
      });

      server.middlewares.use('/__ccs/catalog/token-model', (_req, res) => {
        loadTokensMod()
          .then((mod) => {
            const text = readFileSync(TOKENS_JS_PATH, 'utf8');
            sendJson(res, 200, mod.parseAlmosaferTokensJs(text));
          })
          .catch((err: unknown) => sendJson(res, 500, { error: String(err) }));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), ccsCatalogBridgePlugin()],
});
