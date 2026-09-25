# Trust tiers
> **Purpose:** what each per-project trust tier lets Studio run, where it is stored, and which routes check it · **Read when:** touching anything that runs a user's own code (style compile, package bundle, dev server, deploy, `studio_render_reference`, `studio_lint`), or changing a default · **Trust:** current · **Owner:** security-guard · **Verified:** 2026-09-23

Studio's founding invariant is that it **parses a React project and never executes it**. Three things a design tool needs cannot be done under that rule alone: rendering a component from an arbitrary npm package (its markup exists only when it runs), compiling a project's own Sass/PostCSS/Tailwind (its class names exist only after its build), and comparing a frame against the running app. The trust tier is the per-project permission to run the user's own toolchain for exactly those purposes. **The parse itself never executes anything at any tier.**

---

## TL;DR

| Tier | `trust` value | What Studio may run | Checked by |
|---|---|---|---|
| 0 | `static` | Nothing of the user's. Parse, CSS Modules transform, vendor `.css` reads | nothing to check |
| 1 | `render-packages` | The workspace's own style toolchain in a capped subprocess (`styleCompileTier1.ts`), and its package components bundled and rendered on the canvas (`componentBundle.ts`) | `trust !== 'static'` |
| 2 | `run-project` | Everything in Tier 1, plus the project's own dev server (`devServer.ts`, which live frames and `studio_render_reference` use), the project's own ESLint (`studio_lint`, `projectLint.ts`) and a preview deploy (`deploy.ts`) | `trust === 'run-project'` exactly, via `requireTrustTier` / `checkTrustTier` |

- **Default: every project is `run-project`** (`DEFAULT_TRUST_TIER`, `server/handlers/studio/studioMeta.ts`; owner decision 2026-09-20, [`docs/decisions.md`](../decisions.md)). Nothing promotes automatically, because there is no lower default to promote from.
- The owner lowers a project with the Live pill's **"Back to static"** and can raise it again. Every promote and demote goes through one route.
- **A demotion stops the running dev server**, not just the file field.
- **Tier 2 still runs only a `vite` dev script.** A project whose `dev` (else `start`) script is anything else is `not-vite`: the pill says "Live needs Vite" and the spawner refuses.
- **Tier 2 is a product default, not a consent** (`sec-12`). Anything that needs a human to have agreed must ask at the point of use.

## Where the tier lives

The source of truth is the `trust` field of `<project>/.studio/meta.json`, validated by `TrustTierSchema` in `server/handlers/studio/studioMeta.ts`. Every reader writes `readStudioMeta(projectDir).trust ?? DEFAULT_TRUST_TIER`. The browser keeps a wire-shape mirror of the schema in `src/admin/pages/site/studio/studioProjectTrust.ts`, because it cannot import the Node-only module.

**Read the tier from the project directory, never an app root.** `.studio/` is created at the directory `resolveProjectDir` returns. A monorepo import whose `package.json` sits in `<project>/apps/web` has an app root that is not the project directory, and `<project>/apps/web/.studio/meta.json` does not exist, so reading there silently answers the default. `checkTrustTier(projectDir, required)` in `server/handlers/studio/trustGate.ts` names its parameter for this. The app root is still correct for the project's code: the install cwd, `node_modules`, the dev script.

## The one write path

`GET/POST /admin/api/studio/trust-tier` (`server/handlers/studio/trustTier.ts`):

- `GET ?dir=` returns `{ trust, live }`: the current tier (defaulted) and `resolveLiveCapability(dir)`, which says whether this project's app can be run at all.
- `POST { dir, trust }` persists the tier through `mergeStudioMeta` (every other `meta.json` field is preserved) and then calls `enforceTierOnRunningProcesses`: a write that leaves the project below `run-project` calls `stopDevServer(dir)` before answering.

The demotion has to stop the process because nothing else would. The routes close, but `useDevServerPrewarm` had already started a dev server, the browser-facing start never schedules an idle teardown, and `server/liveOrigin.ts` does not re-read `meta.json` (a project reaches `phase: 'ready'` only if it was allowed to boot, so the proxy trusts the registry).

`styleCompileConsent.ts` (`GET/POST /admin/api/studio/style-compile-consent`) never promotes. It reports whether the board should offer the style-compile prompt, and it can only record "do not ask me again" (`styleCompilePromptDismissed`). The promotion itself goes through `trust-tier`.

## The gates

**Tier 1 (`trust !== 'static'`).** `componentBundle.ts` and `styleCompile.ts` check this before doing anything and answer `200 { ok: false, code }` when it fails, because the caller is a canvas placeholder, not a route refusal. At Tier 0, `styleCompile.ts` records a `style-toolchain-requires-trust-promotion` warning instead of compiling. Both caches key on the tier (`computeBundleCacheKey`, `computeStyleCacheKey`), so a demotion never serves a compile made under the higher tier.

**Tier 2 (`trust === 'run-project'` exactly).** `server/handlers/studio/trustGate.ts` owns the decision and two renderings of it:

- `checkTrustTier(projectDir, required)` is the transport-free verdict.
- `requireTrustTier(projectDir, required, message)` wraps it in `409 { error, code: 'trust-tier-required' }` for HTTP routes: `deploy.ts` and `devServer.ts`'s `status`/`start`. `stop` is deliberately ungated, so a demoted project is always killable.
- Agent and MCP tools (`server/ai/mcp/tools/studio/referenceRender.ts`) call `checkTrustTier` and return a structured `toolRefusal('trust-tier-required', …)`, because a tool result is JSON the model reads.

**A Tier-2 tool needs two gates.** The connector capability `studio.run.project` (`server/auth/capabilities.ts`, granted to Owner and Admin) answers "may this caller run project code at all"; the project's own tier answers "may this project be run". `studio_render_reference` and `studio_lint` (which loads the project's own ESLint config and plugins) check both. Gated by `src/__tests__/architecture/studio-tier2-two-gates.test.ts`.

**The dev-server spawner has its own condition.** `server/handlers/studio/liveCapability.ts` reads the `dev` (else `start`) script from the app root's `package.json` and reports `capable` only when that script invokes `vite` (directly or through a runner such as `npx vite`). The whole live path is a Vite plugin, and without this check the Tier-2 default would run any imported repository's `dev`/`start` script on first open (`sec-20`). It judges the script text, not the probed framework or the presence of a `vite.config`, because Studio's shell scaffold writes a `vite.config.js` into every project it opens. And the script is not what runs: `viteLaunch.ts` runs the project's own installed Vite bin with the script's arguments, never `<pm> run dev`, because every package manager can also run a `predev`/`postdev` script, which the vite-only rule never looked at (security review of #233, F3.4).

## Tier 2 is a product default, not a consent

With `DEFAULT_TRUST_TIER = 'run-project'`, both of a Tier-2 tool's gates are satisfied for every project Studio can run, and no human answered a question to get there. The single-operator posture (`docs/server.md` → "The posture is still single-operator") is what makes that acceptable. Consequences:

- Never describe the tier as the user's consent in UI copy, a prompt, or a security argument.
- A feature that genuinely needs a human's agreement asks at the point of use.
- The standing agent authorization in [`docs/decisions.md`](../decisions.md) is not a user's consent either.

## What stays true at every tier

- **The AST is the source of truth for structure and writeback.** Rendering a package component never produces editable nodes for its internals. It produces one node whose props are editable at the call site. Executing code is a rendering strategy, never a parsing one.
- **Tier 1 code runs only inside the canvas iframe**, never in the admin document. Portal frames are same-origin (the editor portals React into them), so Tier 1 is a blast-radius boundary, not a security boundary: a crash takes out a frame, not the editor.
- **Tier 2 runs the project's own dev server on a separate origin** with no cookies, so the user's code never sees the admin session. See [`live-canvas.md`](live-canvas.md).

## Limitations

- Non-Vite projects (Next.js, CRA, anything whose dev script is not `vite`) cannot run live frames or `studio_render_reference`, at any tier. Their canvas stays on the static render.
- The tier is per project and per machine: it lives in `.studio/meta.json`, which is not a security boundary against someone who can write the project directory.

## Related

- [`docs/decisions.md`](../decisions.md): the 2026-09-20 default and the decisions it superseded
- [`live-canvas.md`](live-canvas.md): what Tier 2 runs and how a live frame works
- [`docs/reference/capabilities.md`](../reference/capabilities.md): `studio.run.project` and the other capabilities
- [`docs/agent-refs/glossary.md`](../agent-refs/glossary.md) → "Trust tiers": the one-paragraph definition
- Source of truth: `server/handlers/studio/studioMeta.ts` (`TrustTierSchema`, `DEFAULT_TRUST_TIER`), `server/handlers/studio/trustTier.ts`, `server/handlers/studio/trustGate.ts`, `server/handlers/studio/liveCapability.ts`
- Gate tests: `src/__tests__/architecture/studio-tier2-two-gates.test.ts`, `src/__tests__/architecture/live-origin-isolation.test.ts`
