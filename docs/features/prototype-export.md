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

A project carrying the built-in design system (§3.1) gets
`import { DesignSystemProvider } from '../design-system'` there — a **relative
path into the project's own folder**, never a package name, and with no
separate stylesheet import: the folder's `index.js` imports the token CSS
itself. The gate is `isDesignSystemBacked(dir)` (the folder is present), not a
`package.json` dependency.

## 3.1. `design-system/` — the other Studio-written folder

The design system Studio renders with is **not an npm dependency**. Every
DS-backed project carries a Studio-written `<project>/design-system/` folder
written from Studio's own vendored copy (`vendor/alm-design-system/src/`), and
every page imports it relatively: `'../design-system'` from `pages/`,
`'../../design-system'` from a page one directory deeper,
`designSystemImportSpecifier` computing it per file.

That is what makes the download honest. `node_modules/` is excluded from the
zip by design, so a synthesized `package.json` naming a design-system package
produced an export that could not `bun install`. With the folder, the
downloaded repo builds with `react`, `react-dom`, `vite` and
`@vitejs/plugin-react` — and nothing else.

`server/handlers/studio/designSystemFiles.ts` owns it, with exactly the
contract the shell's static files have:

| Fact | Where |
|---|---|
| What is written | `index.js`, `components/`, `context/`, `tokens/`, `icons/LineIcons.jsx`, **only** the icon assets something actually imports (≈20 of 568, read statically with a regex — nothing is executed), plus `README.md` and `VERSION`. Files are copied as BYTES, because three of those assets are `.png` |
| "Something", precisely | **two** demand sources. (a) The design system's own components — `.svg` icons AND the three `.png` logotypes (`Button.jsx` -> `card-sample.png`). (b) The PROJECT'S own source: a page carrying `import smsSvg from '../design-system/icons/line-icons/sms.svg?raw'` — which is what the migration writes when it rewrites a deep import of the retired npm — demands an icon no component does. Each source, alone, shipped a project whose `vite build` died on a missing file |
| When | `loadStudioPages` (beside `ensurePrototypeShell`) and `buildStudioDownloadResponse` |
| Who gets it | only a project whose `.studio/meta.json` carries `designSystem: 'alm'` — set by "New project" and by the migration route, never by a GitHub import |
| How staleness is known | `.studio/design-system.json` — `{ version, hash, files }`, a SHA-256 over the whole source set, the project's demanded icons included. A matching hash writes nothing at all; a differing one rewrites the folder in place and removes the files that left the source set — so adding an icon import to a page brings the file in on the next load, and deleting the last import of it takes the file back out |
| What it will never touch | anything outside `<project>/design-system/` and `.studio/design-system.json`. The delete list is the manifest's own `files` array, nothing else |
| Containment | every write target and every source read is checked on its **real** path (`isRealpathContainedAllowingMissing` / `isRealpathContained`), so a planted symlink cannot carry a read or a write out |

`README.md` in the folder says it: *Studio-managed. Edit the design system in
Studio's `vendor/alm-design-system/`, then reopen the project — this folder is
rewritten when stale.* `VERSION` carries the vendored package's own version, so
a version bump is a hash change and therefore a rewrite.

### Migrating a project that still imports the retired npm

`GET/POST /admin/api/studio/design-system/migrate`
(`server/handlers/studio/designSystemMigrate.ts`) moves a project off
the retired npm: it marks the meta, writes the folder, rewrites every import in
the project's own source with the formatting-preserving
`rewriteImportSpecifier` codemod, **writes the folder again**, drops the
dependency from `package.json`, and deletes the installed copy under
`node_modules/`.

The folder is written twice on purpose. Before the rewrite, the project's pages
still name the retired package, so the icons they demand are invisible to
`ensureDesignSystemFiles`' scan and the folder ships without them. After it,
the demand is spelled `'../design-system/icons/…'` and is picked up. The first
write stays because if the rewrite throws, a project with a folder and
unrewritten imports is a better place to be than the reverse.

It runs **from a click and never on load** — the board shows
`DesignSystemMigrateBanner` and a source rewrite is a user action, the same
rule trust promotion follows.

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

### What the bridge reports back, beyond selection (Z5)

The bridge also installs four **runtime-error taps** inside the workspace's own
page — capture-phase `error`, `unhandledrejection`, a pass-through
`console.error` patch, and a `fetch` wrapper — and posts what they find as the
outbound `error` message (`messages.ts`). The parent records those into
`canvasDiagnosticsBuffer.ts` under the iframe's own `contentWindow`, which is
the same key `studio_page_diagnostics` reads, and shows a passive `--warning`
dot on the frame's chrome. Before this, a crash inside a Tier-2 live frame
reached nothing in Studio at all.

Bounded at the sender: 10 posts per second, 50 per document, every free-text
field truncated to the schema's own `maxLength`. See
`docs/agent-refs/canvas-internals.md` → "Runtime diagnostics".

**`vite.config.js` deliberately leaves Vite's own error overlay enabled.** It is
the user's app reporting a compile error in the user's own words, in the frame
where it happened; Studio's badge sits beside it rather than replacing it. The
generated template carries a comment saying so, so nobody switches it off to
make the canvas look tidier.

## 8. Tests

| File | Covers |
|---|---|
| `server/handlers/studio/__tests__/prototypeShell.test.ts` | the write policy: user edits survive, unedited files update, `package.json` merges, `.studio/` awkward cases, `main.jsx`'s bridge-boot imports/gate, `studioRuntimeBridge.generated.js` always coming back |
| `server/handlers/studio/__tests__/prototypeShellBoards.test.ts` | two-board generator output, board order, empty boards, deleted pages, the tab row in `App.jsx`, and the zip actually containing a board created after the last load |
| `server/handlers/studio/__tests__/designSystemFiles.test.ts` | the `design-system/` folder: the exact written set, only-imported assets (including a `.png` copied byte-for-byte), the project's OWN icon demand (added, then removed when the last import goes), idempotence, stale rewrite, stale removal, and every refusal (not DS-backed, no vendored source, a symlinked source file, a symlinked target folder) |
| `server/handlers/studio/__tests__/designSystemMigrate.test.ts` | the migration: relative rewrites at each depth, the dropped stylesheet import, `package.json` formatting, the guarded `node_modules` delete, a refused symlinked install, and a whole-tree hash proving nothing else changed |
| `src/core/ast-codemods/__tests__/rewriteImportSpecifier.test.ts` | the codemod: default/named/namespace imports, sub-paths, quote style, and full-file byte equality where it had nothing to do |
| `server/handlers/studio/__tests__/devServer.test.ts` | `spawnEntry` injecting `STUDIO_PROJECT_KEY_ENV`/`STUDIO_PARENT_ORIGIN_ENV` (present only when `PUBLIC_ORIGIN` is set) alongside the existing `STUDIO_LIVE_BASE_PATH_ENV` |
| `src/__tests__/studio-runtime/runtimeErrorTaps.test.ts` | Z5's four in-frame error taps, the pass-through `console.error` patch and its exact-reference restore, the `fetch` wrapper's unchanged pass-through, and both sender-side bounds (10/s, 50/document) |
| `src/__tests__/canvas/frameAdapter/bridgeFrameErrors.test.ts` | the parent half of the `error` message: verbatim forwarding, and every forged payload the schema's bounds reject |
| `src/__tests__/canvas/canvasDiagnosticsScope.test.ts` | the scope-keyed publication the frame badge subscribes to — stable-reference contract, repeat re-publication, and a reloaded frame clearing the previous document's findings |
| `src/core/studio-runtime/__tests__/vitePlugin.test.ts` | `studioRuntimeIdPlugin()`'s two-plugin split: the config plugin's `apply`-free `resolveId`/`load`, the id-stamp plugin's unchanged `apply: 'serve'` `transform` |
| `src/__tests__/architecture/studio-runtime-bundle-fresh.test.ts` | both generated bundles (`vitePluginBundle.ts`, `runtimeBridgeBundle.ts`) match a fresh re-bundle of their sources |
