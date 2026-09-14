# Prototype export — the runnable shell in the workspace

**Owner modules:** `server/handlers/studio/prototypeShell/` ·
`server/handlers/studioDownload.ts`
**Entry point:** `ensurePrototypeShell(dir)`
**Route:** `GET /admin/api/studio/download`

---

## 1. The problem

A Studio workspace holds the design — `pages/`, `components/`, `i18n/` — and
nothing that can run it. No `index.html`, no entry module, no board. And
everything the canvas knows (which boards exist, where each frame sits, which
direction and colour scheme it was previewed in) lives in `.studio/`, which
the download **deliberately excludes**.

So "Download the code" produced a pile of components that could not start and
had lost the design layer on the way out.

`ensurePrototypeShell` is the fix. It writes a small React app —
`index.html`, `vite.config.js`, `prototype/` — into the workspace, so the
download needs no special case at all: it zips what is there.

The shell is the **viewer** for the design, never a re-expression of it. Not
one byte of a user's page is generated, rewritten or read by it. It imports
them and puts them on a board. That is what keeps "the repository IS the
document" true — Studio generates the harness, never the document.

## 2. What is written, and what is protected

| File | Policy |
|---|---|
| `index.html`, `vite.config.js`, `prototype/App.jsx`, `main.jsx`, `ScreenFrame.jsx`, `Player.*`, `CanvasPanel.*`, `shell.css`, `urlState.js` | updated **while untouched**, frozen the moment you edit one |
| `prototype/registry.generated.jsx`, `prototype/providers.generated.jsx`, `prototype/studioRuntime.generated.js`, `prototype/studioRuntimeBridge.generated.js` | rewritten **every time the generator runs** — the last two are workspace-independent (same bundled content for every project) but still always-rewritten, so a fix reaches an already-scaffolded workspace regardless of whether `vite.config.js`/`main.jsx` are still untouched |
| `package.json` | fields **merged** — an existing value always wins |

`.studio/shell.json` records the SHA-256 of every static file at the moment
Studio wrote it. On the next run, a file whose hash still matches is one nobody
has edited, so a fixed version can safely replace it; a file whose hash differs
belongs to the user now and is never written again.

The first cut of this shell had no manifest and simply never rewrote a static
file — which meant a bug in the scaffold was permanent in every workspace that
had already been opened, and the shipped fix could not reach them. Protecting a
file nobody has edited buys nothing and costs the ability to fix anything.

**This is the contract that lets a scaffold change ship.** Bumping `App.jsx`'s
template is a supported change, not a violation: an unedited copy is updated,
an edited copy is left alone.

## 3. Why generated files rather than reading JSON at runtime

The shell could `fetch('.studio/boards.json')` — and the downloaded zip would
then be broken, because the download excludes `.studio/` by design. Baking the
design layer into source is what makes the export **run**. It is also what
makes a board legible in a git diff.

`registry.generated.jsx` exports:

| Export | What it is |
|---|---|
| `SCREENS` | every page in `pages/`, under the same id Studio addresses it with |
| `BOARDS` | Studio's boards, **in `.studio/boards.json` order** — one board is one tab |
| `PROJECT_NAME`, `FRAME_DEFAULTS`, `PREVIEW_AXES`, `LOCALES` | the shell's chrome and its opening state |
| `LINKS` | the prototype links authored on the board (`.studio/prototype.json`) |
| `applyColorSchemeGate` | the project's own dark-mode gate, as `projectProbe` detected it |

`providers.generated.jsx` is generated for one reason: a static import cannot
be conditional, and the one thing that genuinely differs between projects is
which providers exist. Putting that seam in its own tiny generated file is what
lets `App.jsx` be written once and then belong to the user.

## 4. Boards are tabs

Every board in `.studio/boards.json` gets a tab, in file order, in **both**
views. The active board is the only one `CanvasPanel` draws, and the screen row
lists that board's frames.

Three rules the generator holds to:

- **A board with no frames still gets an entry.** It is a tab the author
  created; hiding it would make the export disagree with Studio about how many
  boards exist.
- **A frame whose page no longer exists is dropped.** That one would be a
  broken import, not an empty tab.
- **Board order is file order.** Not alphabetical, not ranked by frame count —
  the tab row reads left to right the way the author sees it in Studio.

`LINKS` stays **project-wide**, not scoped to the active tab. A link in
`.studio/prototype.json` addresses a *screen*, not a board, so scoping it to
the tab would break a jump to a screen the author placed on a different board.
The tabs scope what you *see*; they do not amputate the flow.

## 5. When the generator runs

Two triggers, and both are needed:

1. **`loadStudioPages`** — every project open, before the load memo. The memo's
   fingerprint (`workspaceLoadFingerprint`) covers the user's *source*, not
   `.studio/boards.json`, so creating a board is a memo **hit**; a regeneration
   placed inside `computeStudioPages` would be skipped exactly when the boards
   it reads have changed.
2. **`buildStudioDownloadResponse`** — before the zip is built. This is what
   makes a board created since the project was opened appear in the download.
   Without it, `registry.generated.jsx` shipped whatever the boards were the
   last time the parse ran.

`ensurePrototypeShell` never throws. A project it cannot scaffold (an
unreadable directory, an escaping `pagesDir`, a corrupt `boards.json`) must
still open and must still download — the shell is an addition to a workspace,
never a precondition for reading one.

It is also cheap on the common path: static files are `existsSync` checks, and
the generated ones are only written when their content actually differs — a
needless rewrite would move `package.json`'s mtime and invalidate caches keyed
on it.

## 6. Why `prototype/` is invisible to the parse

`PROTOTYPE_SHELL_DIR` and `isPrototypeShellPath` live in
`src/core/page-parser/workspaceFiles.ts`, deliberately **not** in
`EXCLUDED_WORKSPACE_DIR_NAMES`. The distinction is the whole point:
`listWorkspaceFiles` must walk `prototype/`, because the download has to ship
the shell — but nothing in the parse pipeline may treat it as the user's app.

Three consumers enforce that:

| Consumer | What goes wrong without it |
|---|---|
| `findEntryFile` (`collectPageStylesheets.ts`) | The shell's `index.html` points at `prototype/main.jsx`, so it was adopted as the project's entry and `shell.css` / `CanvasPanel.css` were walked in as the user's design system. Every page picked up style rules nobody wrote. |
| `NON_PAGES_DIR_SEGMENTS` (`projectProbe.ts`) | Every file in `prototype/` is a JSX-returning default export — exactly what the pages-dir heuristic scores on — so a re-probe could rank the shell above the real `pages/`. |
| `extractLocalComponentCatalog` (`componentSpecExtract.ts`) | `App` and `CanvasPanel` appear in the component picker — Studio offering the user its own scaffold to place on their canvas. |

## 7. The live-canvas runtime bridge boot (Track L, `live-08`)

Two generated files carry logic that has nothing to do with `.studio/`'s
content and exist purely to reach an already-scaffolded workspace
independent of that workspace's own freeze state:

- **`prototype/studioRuntime.generated.js`** (L3) — the workspace-side Vite
  plugin (`@core/studio-runtime/vitePlugin.ts`, bundled by
  `scripts/sync-studio-runtime.ts`). `vite.config.js` imports
  `studioRuntimeIdPlugin()`, which returns **two** plugin objects, not one:
  - `studio-runtime-config` — resolves/loads the `virtual:studio-runtime`
    module `main.jsx` imports. Carries **no** `apply` restriction, so it
    resolves during `vite build` too (Download the code, preview deploys),
    not only `vite dev`.
  - `studio-runtime-id-plugin` — stamps every host JSX element with
    `data-node-id`. `apply: 'serve'`-scoped: a build/download must never
    carry that attribute.

  The split exists because `apply` is a **plugin-level**, not per-hook, field
  in Vite — one `apply: 'serve'`-scoped plugin object cannot resolve a module
  at build time while excluding a `transform` from it.

- **`prototype/studioRuntimeBridge.generated.js`** (L4) — the in-frame
  runtime bridge (`@core/studio-runtime/runtime.ts`'s
  `createStudioRuntimeBridge`, bundled the same way). `main.jsx` imports it
  and boots it gated on **both**:
  ```jsx
  if (STUDIO_RUNTIME_CONFIG.parentOrigin && window.parent !== window) {
    createStudioRuntimeBridge({ parentOrigin: STUDIO_RUNTIME_CONFIG.parentOrigin, hot: import.meta.hot })
  }
  ```
  `STUDIO_RUNTIME_CONFIG` (the `virtual:studio-runtime` module's export) comes
  from `STUDIO_PROJECT_KEY_ENV`/`STUDIO_PARENT_ORIGIN_ENV`
  (`@core/studio-runtime`'s `runtimeConfig.ts`) — env vars
  `server/handlers/studio/devServer.ts`'s `spawnEntry` injects into the
  subprocess **only when Studio's own dev-server manager spawned it**, from
  `registeredMcpServerProjectKey(dir)` (the same key `/p/<projectKey>/`
  routing uses) and `resolvePublicOrigins(process.env)[0]`. A plain
  `npm run dev` — including every copy handed out via "Download the code" —
  never sets them, so `parentOrigin` is `null` and the gate above is a no-op.
  `window.parent !== window` is the second, independent half of the gate: a
  supervised dev server opened directly in a bare browser tab (the raw Vite
  port is reachable outside the `/p/` proxy too) must not boot a bridge with
  nothing to talk to.

  See `STUDIO-LIVE-CANVAS-PLAN.md` §L3/§L4 for the wider design and
  `src/core/studio-runtime/runtime.ts`'s own header for the bridge's security
  posture (origin + source-window checks on every inbound message).

## 8. Tests

| File | Covers |
|---|---|
| `server/handlers/studio/__tests__/prototypeShell.test.ts` | the write policy: user edits survive, unedited files update, `package.json` merges, `.studio/` awkward cases, `main.jsx`'s bridge-boot imports/gate, `studioRuntimeBridge.generated.js` always coming back |
| `server/handlers/studio/__tests__/prototypeShellBoards.test.ts` | two-board generator output, board order, empty boards, deleted pages, the tab row in `App.jsx`, and the zip actually containing a board created after the last load |
| `server/handlers/studio/__tests__/devServer.test.ts` | `spawnEntry` injecting `STUDIO_PROJECT_KEY_ENV`/`STUDIO_PARENT_ORIGIN_ENV` (present only when `PUBLIC_ORIGIN` is set) alongside the existing `STUDIO_LIVE_BASE_PATH_ENV` |
| `src/core/studio-runtime/__tests__/vitePlugin.test.ts` | `studioRuntimeIdPlugin()`'s two-plugin split: the config plugin's `apply`-free `resolveId`/`load`, the id-stamp plugin's unchanged `apply: 'serve'` `transform` |
| `src/__tests__/architecture/studio-runtime-bundle-fresh.test.ts` | both generated bundles (`vitePluginBundle.ts`, `runtimeBridgeBundle.ts`) match a fresh re-bundle of their sources |
