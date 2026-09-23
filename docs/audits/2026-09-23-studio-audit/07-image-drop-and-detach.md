# Audit 07: image drag and drop onto the canvas, and "detach component"

Auditor: studio-architect (read-only). Repo HEAD: `560ddb0e` on `fix/studio-load-memo-cold-on-every-load`.
Penpot reference: `../penpot`, at `frontend/src/app/main/ui/workspace/viewport/actions.cljs:524` (`on-drop`),
`frontend/src/app/main/data/workspace/media.cljs` and `common/src/app/common/logic/libraries.cljc:324` (`generate-detach-instance`).

> **Headline: both features already exist in the codebase.** Neither spec is greenfield.
> - **Image drop** shipped as D2 G15 (`canvas-20`, PR #172, `STATE.md:2900`). An OS file dropped on a frame goes to `public/`, and `<img src alt>` is written at the drop index as one structural commit, with an undo entry (`store-14`) and an e2e test (`tests/e2e/frame-file-drop.e2e.ts`).
> - **Detach** shipped as WS-4.4. It has a codemod, the `kind:'detach'` edit, the Component-section button, the refusal dialog remedy, and the `extractComponentCopy` escape hatch (`docs/features/studio-import.md:470`).
>
> Both specs below therefore cover **the gaps and bugs in what shipped** plus the missing Figma verbs. Neither redesigns anything.

---

## SPEC A: drag and drop images onto the canvas

### A.0 What exists today (verified by reading)

| Piece | File | State |
|---|---|---|
| Shared write pipeline: magic-number sniff (png/jpg/gif/webp/avif/svg), SVG sanitise (`sanitizeSvgBytes`), containment on the real path of the nearest existing ancestor, excluded dirs, collision-safe `<base>-N.<ext>` naming, derived filename | `server/handlers/studio/assetLanding.ts` (`landAssetBytes`, `resolveAssetWriteDir`, `sniffImageExtension`) | solid, 3 callers |
| `POST /admin/api/studio/asset-drop`: server-derived `public/` under `resolveAppRoot`; creates `public/` only for a known framework, otherwise 409 with a remedy; returns `{relPath, src}` | `server/handlers/studio/assetDrop.ts` | shipped, declared `routeCapabilities.ts:212` (`studio.write`) |
| `POST /admin/api/studio/asset-upload`: client-chosen `targetDir` (default `src/assets`), 25 MB streamed cap | `server/handlers/studio/assetUpload.ts` | shipped, `routeCapabilities.ts:205` |
| `GET /admin/api/studio/project-assets`: lists the workspace's images | `server/handlers/studio/projectAssets.ts` | shipped (`site.read`) |
| Server-side URL fetch with SSRF guard (DNS pinning, no redirects, streamed cap), then `landAssetBytes` | `server/handlers/studio/remoteAssetFetch.ts` + `server/util/ssrfGuard.ts` | MCP-only (`studio_fetch_remote_asset`), no browser route |
| Gesture: window-level `dragover`/`drop`; rAF preview with zero React commits; refusals decided before any network call | `canvas/useCanvasFileDrop.ts`, `canvas/canvasFileDrop.ts`, `canvas/canvasFileDragPreview.ts` | single file only |
| Iframe relay: cancels **every** drop in a design frame (a dropped link would otherwise navigate the frame) and relays only `Files` | `canvas/canvasFrameDragRelay.ts` | shipped (sec-17) |
| Store commit: `insertImageIntoPage(pageId, parentId, index, {src, alt})` goes through `planSourceInsert`, then `commitStudioInsert({name:'img', props})`, queued behind `structuralCommitQueue`; the undo inverse is `delete` | `store/slices/site/imageDropActions.ts` | shipped; **no optimistic preview** |
| Inspector: replace the image on a selected `<img>`. An import-bound one is repointed via `setImportSpecifier` (`kind:'asset'`, `assetOrigin`); a literal one goes through `onChange` | `panels/PropertiesPanel/ImageSourceSection.tsx`, `ast-codemods/setImportSpecifier.ts` | shipped |
| Fill image layers (`background-image`), picker with Project/Upload/URL tabs | `panels/PropertiesPanel/ImageSourcePicker.tsx`, `inspector/sections/FillSectionActions.tsx`, `imageFillValue.ts` | shipped |
| `base.image` module (`imageEdit: {prop:'src'}`), props `src/loading/fetchPriority/decoding/htmlAttributes` | `src/modules/base/image/` | shipped |

### A.1 Bugs and inconsistencies found (fix first)

1. **BUG: a literal-`src` replace writes a URL that breaks in production.** `ImageSourceSection.tsx:95-106` calls `uploadStudioAsset(file)` without a `targetDir`, so the file lands in `src/assets/`, and then writes `onChange(prop, '/' + relPath)`, which gives `src="/src/assets/x.png"`. `assetDrop.ts`'s own doc says this is exactly the URL that "works in `vite dev` and 404s in production". Fix: for the literal case, land through `asset-drop` (public/) and use its `src`.
2. **Three copies of the "public file to site-root URL" rule.** `droppedAssetSrc` (server, `assetDrop.ts`), `cssUrlForAssetPath` + `PUBLIC_ROOT_DIRS` (client, `imageFillValue.ts`), and the bare `'/' + relPath` in `ImageSourceSection`. Also `IMAGE_FILL_UPLOAD_DIR = 'public'` is joined to the *project* dir, so it ignores `resolveAppRoot`, and in a monorepo a fill upload lands in the wrong `public/`. Collapse this to one rule: the server returns `src` for every landing, and the client stops deriving URLs.
3. **Two answers to "which project dir".** `dropStudioAsset` uses `studioWriteDir()`, while `uploadStudioAsset` uses `getStudioWorkspaceDir()`. That second call skips `loadedDir`, so a session with no explicit selection falls back to the server's first project. That is usually the same project, but it is not guaranteed. Use `studioWriteDir()` everywhere.
4. **The multi-file refusal is stale.** `canvasFileDrop.ts` `refuseDroppedFile` rejects `count > 1` because "each write moves the next one's line numbers". But `imageDropActions.ts` already queues and re-plans for exactly that reason ("dropping three files at once is three images, not one"). Only the refusal stands in the way.
5. **No content dedupe.** Dropping the same image twice writes `photo.png` and then `photo-2.png`, with identical bytes. This also blocks the idempotent-replay fix: `STATE.md:2015-2022` names `/asset-drop` and `/asset-upload` as the top remaining replay gap because a retry creates a second file.
6. **Undo leaves the file behind.** Undo of an image drop is `delete <img>`, and the `public/x.png` stays. That is a deliberate and correct default (see A.9), but nothing surfaces the orphans.

### A.2 Drop sources: the final matrix

| Source | Transport | Plan |
|---|---|---|
| OS file(s) | `DataTransfer.files` | exists (1 file). IMG-2 lifts the limit to N |
| Clipboard paste of an image (screenshot, "Copy image") | `paste` event `clipboardData.files` / `items[kind=file]` | **new** (IMG-4) |
| Image dragged from another browser tab | `text/uri-list` (http[s]) and/or `Files` (Chrome often supplies both); Firefox may give `data:image/...` | **new** (IMG-5): an http(s) URL goes to the server fetch; `data:` is converted to a Blob client-side, then the normal drop path |
| Assets panel image card | in-app pointer drag (not HTML5 DnD; `single-drag-mechanism` gate) | **new** (IMG-6), reuses `project-assets` with no upload |
| Existing `<img>` as target | same gestures, with the hit-test resolving to an `<img>` node | **new** (IMG-3): replace `src` |
| Container as target with a modifier | same gestures | **new** (IMG-7): `background-image` layer |

Penpot handles `Files`, `text/uri-list` (http, then fetched; `data:image/`, then blob) and paste in one `upload-media-workspace` path. Mirror that: **one intake function turns every source into `File[]` or `{url}`**, then one landing call, then one placement.

### A.3 Where the file is stored (the convention decision)

Keep `asset-drop`'s rule as the default: **`public/` under `resolveAppRoot`, literal `src="/name.ext"`**. It is the one location every recognised framework serves verbatim and unhashed, and it needs no import. The doc's reasoning holds.

Add the **import convention** as a detected, honest alternative. This is not a toggle:

- The argument in `assetDrop.ts` that `import` + `src={x}` is "two edits in two places" is weaker than it reads. `insertJsxElement` already adds an import and an element **in the same file, in one write**, whenever it inserts a component (`importSpecifier`). One file with one codemod is one honest target.
- Detect the convention from the parsed tree, which is static and needs no execution. Count the page's image nodes with `assetOrigin` (import-bound) against those with literal `src` strings under a public root. The majority wins. A tie or zero goes to `public/`.
- **Import mode is refused for `next-app`/`next-pages`.** There `import x from './a.png'` yields `StaticImageData`, and `<img src={x}>` renders `[object Object]`. Next projects always get `public/` plus a literal.
- In import mode the file lands in the directory the majority of existing image imports point at (fallback `src/assets`, the existing `DEFAULT_ASSET_TARGET_DIR`), through `landAssetBytes` with a **server-derived** `targetDir`. The client never supplies it, so `asset-drop` keeps its "no traversal surface" property.

Server contract change (single route; `asset-upload` stays for the inspector's explicit-target case):

```ts
// POST /admin/api/studio/asset-drop   multipart: dir?, file, pageRel (for convention + relative specifier)
// 200:
type AssetDropResponse =
  | { ok: true; mode: 'public'; relPath: string; src: string; width: number | null; height: number | null; deduped: boolean }
  | { ok: true; mode: 'import'; relPath: string; width: number | null; height: number | null; deduped: boolean }
```

`width`/`height` are read server-side from the header bytes that were already sniffed: the PNG IHDR, the JPEG SOFn, GIF LSD, WebP VP8/VP8L/VP8X, and the SVG `width`/`height`/`viewBox` of the sanitised text. AVIF `ispe` is optional, and `null` means unknown. The work is in `assetLanding.ts`, next to `sniffImageExtension`, and it is pure.

### A.4 Naming and dedupe

- Keep `sanitizeAssetBaseName` + the sniffed extension, so names stay human-readable. Do **not** switch to hash filenames, because `public/hero.png` is what a developer expects to see in their repo.
- **Dedupe by content** in `landAssetBytes`. Before writing, scan `writeDir`'s own entries (not recursive) that share the sniffed extension **and the same byte length**. For those, compare SHA-256 (`Bun.CryptoHasher`). If one matches, return that existing `relPath` with `deduped: true`. The cost is bounded: same size and same dir only.
- Dedupe makes a lost-response retry naturally idempotent. That makes it safe to add `/admin/api/studio/asset-drop` to `IDEMPOTENT_REPLAY_PATHS` (`src/core/http/apiClient.ts:127`) with the matching server replay (`server/handlers/studio/idempotentReplay.ts`). This closes the gap `STATE.md` names.
- TOCTOU: `uniqueAssetPath` then `writeFileSync` is racy under concurrent drops of the same name. Write with `flag: 'wx'` and loop on `EEXIST`.

### A.5 Size limits, type validation, security

Keep everything as it is. It is already correct, and it lives in one place:

- A 25 MB streamed cap (`readFormDataWithLimit`), shared by drop and upload. For N files, each file is its own request, so each file gets the cap. There is no aggregate cap because each request is bounded.
- The bytes decide the format. The declared MIME type and name are hints only, and the client-side `looksLikeImage` is a courtesy for the refusal sentence.
- SVG is sanitised before disk (`sanitizeSvgBytes`, the same sanitiser as the CMS media upload). Add a test proving that `<svg onload>`, `<script>`, `<foreignObject>` and `xlink:href="javascript:"` are stripped **on the drop route** (`assetDrop.test.ts`). Today that is covered only indirectly via `assetLanding.test.ts`.
- Path traversal: `asset-drop` has no client path input. Import mode keeps that, because `targetDir` is server-derived from parsed imports and then still passes `resolveAssetWriteDir`.
- A URL drop (IMG-5) needs a **new browser-facing route**, `POST /admin/api/studio/asset-drop-url {dir?, url, pageRel}`, that calls the existing `fetchRemoteBytes` (SSRF: http/https only, every resolved address checked against the private/loopback/metadata blocklist, the connection pinned to the validated address, `redirect:'error'`, streamed cap, generic errors). It must be declared in `server/handlers/studio/routeCapabilities.ts` as `{ path: '/admin/api/studio/asset-drop-url', read: null, mutate: 'studio.write' }` and registered in `server/handlers/studio/subRouters.ts`. That is two edits, or `studio-routes-capability-declared.test.ts` fails. **security-guard review required**: this turns an MCP-only outbound fetch into a one-click browser action. Treat `loopbackAssetFetchEnabled` as off for this route.
- A `data:` URI is decoded **client-side** into a Blob and posted to plain `asset-drop`. The server never parses `data:`.

### A.6 The AST write and placement

- **Target resolution:** keep `resolveCanvasInsertionTarget` (container + index from the cursor) and `planSourceInsert` with its refusal and retry path. Nothing new.
- **Element:** `<img src="/hero.png" alt="hero" width={W} height={H} />` in public mode, or `<img src={heroPng} alt="hero" ... />` + `import heroPng from '../assets/hero.png'` in import mode.
  - `width`/`height` are **HTML attributes** (they reserve an aspect ratio and prevent layout shift). Use the intrinsic size, **clamped to the drop container's measured content-box width** (from the candidate rect already in the drag session) with the aspect preserved. A 4000 px photo dropped in a 390 px frame should not write `width={4000}`. This mirrors Penpot's `image-uploaded`, which creates the shape at its natural size. If the dimensions are unknown (`null`), omit both attributes; do not guess.
  - `alt`: keep `altTextFor(file)`.
- **Import mode needs one new insert prop form.** `InsertPropValue` (`studioSaveRequests.ts:283`) / `JsxPropValueSchema` gain `{ __assetImport: string }` (a workspace-relative file). `insertJsxElement` resolves it to a relative specifier from the page file (`relativeSpecifier` in `importReconcile.ts`), picks a free camelCase local name (`topLevelBindingNames`), adds the default import, and writes `src={name}`, all in the one existing write. The server re-validates the path with `resolveContainedAssetPath` (already used by `kind:'asset'`).
- **Absolute placement.** Follow K6's rule (`canvasFreeMove.ts`) and do not invent a second one. A plain drop is **flow** (index). A **Cmd/Ctrl-drop** whose resolved container is a positioned element adds `style={{ position: 'absolute', left, top }}` computed in the container's local space. It refuses on a static parent with `explainStaticParentConstraint`'s remedy. It is never automatic.
- **Drop onto an `<img>` (replace).** If the hit-test's deepest node under the pointer is an `imageEdit` module (`base.image`), the drop means **replace**, not insert. The preview chip says "Replace image". Then:
  - an import-bound source (`assetOrigin`) is repointed through `saveStudioAssetEdit` (the existing `kind:'asset'` + `setImportSpecifier`), with the file landing beside the old import's target dir, server-derived from `assetOrigin`;
  - a literal source goes through a `kind:'prop'` write of the new `src`;
  - a code-valued `src` (in `codeProps`) refuses with the existing locked-prop sentence;
  - the shared-asset warning applies when N nodes resolve to one import (WS-8.3 item 4).
  Holding **Alt** forces insert-beside instead.
- **Drop onto a container with Shift: background image.** This is not the default, because Figma's and Penpot's default is "new image layer". It writes a `background-image` layer through the same `writeBackgroundModel` + `insertBackgroundLayer(model, 0, url(...))` the Fill picker uses. `commitApi.ts` is a hook bound to the selection (`useInspectorCommit(model)`), so extract its non-React core into `buildInspectorCommit(model, actions)` and have `useInspectorCommit` call it. The drop gesture then selects the target node and calls the same core. This gives one write-target resolver, with no second copy.

### A.7 Optimistic preview

Today nothing is shown until the resync, which for a large image means about 1 upload plus 1 write plus 1 reparse of dead time. Add a preview in two phases, reusing `perf-10`'s machinery:

1. **On drop:** create `URL.createObjectURL(file)` and call `previewOptimisticInsert(helpers, 'base.image', {src: objectUrl, alt}, parentId, index, ghostId)` against **the dropped page**. This needs one change: `previewActiveTreeMutation` targets the active tree, so either activate the frame first (`openPageInCanvas(pageId)`; a drop is a user gesture on that frame, which is honest) or add a page-explicit sibling `previewPageTreeMutation(pageId, fn)`. **Pick activate-then-preview.** It is less machinery, and it makes the drop select its result the way Figma does.
2. While uploading, the ghost carries a `data-studio-uploading` attribute read by a design-mode injector rule (dimmed plus a progress bar via `--studio-upload-progress`). Progress comes from XHR `upload.onprogress`: move `dropStudioAsset` onto the same XHR helper `uploadStudioAsset` uses, and extract one `postMultipartWithProgress` into `src/admin/pages/site/studio/` so there is one XHR client, not two.
3. When the landing resolves, `commitStudioInsert({..., optimistic: handle})`. The resync replaces the page and erases the ghost. On a refusal or network failure, `commitStructuralBody` already rolls it back. **Revoke the object URL** in both outcomes.

Remove `insertImageIntoPage` from the "unchanged, nothing shown" list in `docs/agent-refs/editor-store.md:354-381`.

### A.8 Multi-file drop

- Lift the `multiple-files` refusal (IMG-2). The preview chip reads "Add N images".
- Land the files **in parallel** (independent files), then write them as **one insert edit carrying N sibling elements**. Extend `InsertEditSchema` with `siblings?: InsertNode[]`, or make `insertJsxElement` accept `InsertJsxNode[]` at one anchor. The result is **one write, one resync, one undo step** (the inverse is N deletes in one `source` entry), matching Penpot's `detach-components`-style single undo transaction.
- Do not use N queued inserts. They would give N undo steps and N reparses.
- A partial landing failure (one file refused by the sniff) still writes the others, and one toast names the refused ones.

### A.9 Undo, redo, orphans

- Undo stays `delete` of what was inserted; `store-14` already does this. **Undo does not delete the file.** Redo needs it, a deduped file may be referenced elsewhere, and deleting user files as a side effect of Cmd-Z is the wrong risk. The one exception is replace mode: undo is the inverse `kind:'asset'` or `prop` write pointing back at the old path, and both files stay.
- **Orphans, surfaced and not auto-GC'd (IMG-8):** keep a ledger `.studio/assets.json` (`{ relPath, sha256, landedAt }[]`, written by `landAssetBytes` for the drop, upload and URL callers; Studio state on disk). The Assets-panel Images section (IMG-6) shows "N unused images Studio added". A file is unused when it is in the ledger and **no workspace source file contains its basename** (`listWorkspaceFiles` + a text scan, no execution). "Delete unused" is an explicit, confirm-dialog action on a new route, `POST /admin/api/studio/asset-prune`, declared in `routeCapabilities.ts` (`studio.write`). It deletes **only ledger entries** and never a file Studio did not land.

### A.10 Work orders

| id | Title | Files | Owner | Effort | Tests |
|---|---|---|---|---|---|
| **IMG-1** | One landing contract: fix the `/src/assets` literal bug; server returns `src` for every landing; one project-dir helper; dedupe; `wx` write; intrinsic dims | modify `server/handlers/studio/assetLanding.ts` (dedupe, `wx`, `readImageDimensions`), `assetDrop.ts` (return `width/height/deduped`), `assetUpload.ts` (return `src` when landing under a public root); modify `src/admin/pages/site/studio/uploadStudioAsset.ts` (`studioWriteDir`), `dropStudioAsset.ts`; modify `panels/PropertiesPanel/ImageSourceSection.tsx` (literal case uses the drop route's `src`), `imageFillValue.ts` (delete `cssUrlForAssetPath`'s derivation, consume server `src`; `IMAGE_FILL_UPLOAD_DIR` removed in favour of the drop route); modify `src/core/http/apiClient.ts` + `server/handlers/studio/idempotentReplay.ts` (add `/asset-drop`) | server-engineer + panel-designer | M | `assetLanding.test.ts` (dedupe same-bytes returns the existing path; same-size different bytes gets a new file; dims for png/jpg/gif/webp/svg; `wx` race), `assetDrop.test.ts` (SVG script stripped on this route; `deduped:true` on a replay), `ImageSourceSection` unit test (literal replace writes `/x.png`, never `/src/assets/...`) |
| **IMG-2** | Multi-file drop as one write | modify `canvas/canvasFileDrop.ts` (drop the `multiple-files` refusal; the plan carries `File[]`), `canvasFileDragPreview.ts` (chip "Add N images"), `useCanvasFileDrop.ts`, `store/slices/site/imageDropActions.ts` (`images: DroppedImage[]`), `store/slices/site/types.ts`; modify `server/handlers/studioStructuralWriteback.ts` (`InsertEditSchema.siblings`), `src/core/ast-codemods/insertJsxElement.ts` (N siblings at one anchor, validated as a whole before writing), `studio/studioStructuralCommits.ts` | canvas-engineer + parser-surgeon | M | `insertJsxElement.test.ts` (3 siblings, one write, order preserved; one invalid sibling means nothing written), `canvasFileDrop.test.ts` (N files gives one plan), `imageDropInsert.test.ts` (one undo entry with N deletes), e2e: extend `frame-file-drop.e2e.ts` with a 3-file drop |
| **IMG-3** | Drop onto an `<img>` replaces it | modify `canvas/canvasFileDrop.ts` (replace target: deepest `imageEdit` node under the point; Alt forces insert), `canvasFileDragPreview.ts` ("Replace image"); new `store/slices/site/imageReplaceActions.ts` (`replaceImageSource(pageId, nodeId, landed)`, routing to `saveStudioAssetEdit` or a prop write; undo entry = inverse); `docs/agent-refs/editor-store.md` | canvas-engineer + store-engineer | M | `canvasFileDrop.test.ts` (over an img gives replace; Alt gives insert; code-valued `src` refuses), `imageReplace.test.ts` (import-bound gives a `kind:'asset'` edit; literal gives a `prop` edit; undo restores the old path), e2e case |
| **IMG-4** | Paste an image from the clipboard | new `canvas/useCanvasImagePaste.ts` (window `paste`, image items only, skip inputs and contenteditable via `editorKeyGuards.ts`); modify `canvas/useCanvasNodeShortcuts.ts` (Cmd-V must stop `preventDefault`-ing on keydown, because that suppresses the `paste` event; node paste moves into the `paste` handler); modify `store/slices/clipboardSlice.ts` + `store/clipboard/clipboardStorage.ts` (on copy, also write a marker `text/plain`/`web application/x-studio-nodes` carrying `copiedAt`, so a paste can tell "the OS clipboard holds Studio nodes I copied" from "the OS clipboard holds a newer image"); target = the selection's container, else the active frame root, at the index after the selection (the same as `pasteNode(..., 'after')`) | canvas-engineer + store-engineer | M | `useCanvasImagePaste.test.ts` (image file wins when no Studio marker; the marker matching `copiedAt` gives node paste; paste inside an `<input>` is ignored), keybinding gate unchanged (`layers.paste` still one entry) |
| **IMG-5** | Drag an image from another tab (URL / `data:`) | new route `server/handlers/studio/assetDropUrl.ts` (calls `fetchRemoteBytes`, then the same home and landing as `assetDrop`); modify `server/handlers/studio/routeCapabilities.ts` (declare it), `server/handlers/studio/subRouters.ts`; modify `canvas/canvasFrameDragRelay.ts` (relay `text/uri-list` **only** when it is an http(s) or `data:image/` URI; still cancel everything), `canvas/useCanvasFileDrop.ts` + `canvasFileDrop.ts` (intake: `Files` wins over `uri-list`; `data:` decoded to a Blob client-side); new `studio/dropStudioAssetUrl.ts` | server-engineer + canvas-engineer, **security-guard review** | M | `assetDropUrl.test.ts` (private IP, redirect, `file:`, oversize and non-image all refused; nothing written), `studio-routes-capability-declared.test.ts` passes, `canvasFrameDragRelay` test (`javascript:` and plain-text uri-list are cancelled and not relayed) |
| **IMG-6** | Assets panel "Images" section + drag to canvas | new `panels/AssetsPanel/ImagesSection.tsx` (+ `.module.css`), uses `useProjectImageAssets` and `studioAssetPreviewUrl`; a pointer drag through the existing canvas element-drag session (not HTML5 DnD, per the `single-drag-mechanism` gate); lands with **no upload**, only an insert with `src` from `cssUrlForAssetPath`'s server replacement or `__assetImport`; modify `AssetsPanel.tsx` | panel-designer + canvas-engineer | M | `ImagesSection` unit test; `single-drag-mechanism.test.ts` unchanged; e2e: drag a card into a frame |
| **IMG-7** | Shift-drop onto a container gives a background image | modify `inspector/commitApi.ts` (extract `buildInspectorCommit(model, actions)`; the hook wraps it), `canvas/canvasFileDrop.ts` (Shift target = the container itself), new `store/slices/site/imageFillDropActions.ts` (select the node, then `insertBackgroundLayer` via `writeBackgroundModel`) | store-engineer + canvas-engineer | S-M | `commitApi` extraction test (hook and builder give identical targets), `imageFillDrop.test.ts` (a class target writes the class; an inline target writes inline; a locked `backgroundImage` refuses) |
| **IMG-8** | Optimistic ghost + upload progress | modify `imageDropActions.ts` (activate the frame, then `previewOptimisticInsert` with the object URL, then pass `optimistic` to `commitStudioInsert`), `studio/dropStudioAsset.ts` (XHR via a new shared `studio/postMultipartWithProgress.ts`; `uploadStudioAsset.ts` and `uploadDesignReference.ts` move onto it); a design-mode injector rule for `[data-studio-uploading]`; `docs/agent-refs/editor-store.md` | store-engineer + canvas-engineer | M | `imageDropInsert.test.ts` (ghost present before the commit resolves; rolled back and URL revoked on a refusal); **e2e** (`bun run test:e2e`, standing-02): the ghost is visible with measured non-zero rect before the resync |
| **IMG-9** | Width/height and Cmd-drop absolute | `imageDropActions.ts` (attributes from `width/height` clamped to the container rect), `canvasFileDrop.ts` (Cmd: positioned-parent check reusing `explainStaticParentConstraint`; `left/top` in container space; RTL: `inset-inline-start` as in K6) | canvas-engineer | S | `canvasFileDrop.test.ts` (clamp maths; static parent refuses with a remedy), e2e: Cmd-drop lands at the pointer (measured rect) |
| **IMG-10** | Import-convention mode | modify `server/handlers/studio/assetDrop.ts` (`resolveDroppedAssetHome` gets a convention probe: reads the parsed page's `assetOrigin` counts; Next gives public), `insertJsxElement.ts` + `JsxPropValueSchema` (`__assetImport`), `studioSaveRequests.ts` (`InsertPropValue`) | parser-surgeon + server-engineer | M | `assetDrop.test.ts` (Vite page with majority imports gives import mode; Next gives public), `insertJsxElement.test.ts` (`__assetImport` writes a default import with a free name and a relative specifier; collision gives `heroPng2`) |
| **IMG-11** | Asset ledger + unused-image prune | new `server/handlers/studio/assetLedger.ts`, `assetPrune.ts` (+ `routeCapabilities.ts` declaration, `subRouters.ts`); `assetLanding.ts` appends to the ledger; `ImagesSection.tsx` "N unused" | server-engineer + panel-designer, security-guard | M | `assetPrune.test.ts` (never deletes a non-ledger file; never deletes a referenced file; symlink-escaped ledger entry refused) |

**Order:** IMG-1, then (IMG-2, IMG-3, IMG-8) in parallel, then IMG-4, IMG-9, IMG-7, then IMG-5, IMG-6, IMG-10, then IMG-11. IMG-1 comes first because every later order consumes its response shape.

**Architecture gates to update:** `single-drag-mechanism.test.ts` (the paste listener is not DnD; IMG-6 must *not* add an allowlist entry); `studio-routes-capability-declared.test.ts` (IMG-5, IMG-11 declarations); `boundary-validation.test.ts` (new XHR helper validates via `compiledCheck`, same as today).

**Docs:** `docs/agent-refs/canvas-internals.md` (drop intake matrix), `docs/agent-refs/editor-store.md` (image drop now optimistic, multi-sibling undo), `docs/agent-refs/studio-pipeline.md` (`__assetImport`, siblings), `docs/server.md` (new routes), `docs/reference/canvas-dnd.md`, and `STUDIO-IMPORT-V2-PLAN.md` WS-8.3 (mark shipped pieces).

### A.11 Risks

- **Cmd-V semantics change (IMG-4).** Moving node paste from `keydown` to the `paste` event could regress paste where the canvas lacks focus. Mitigation: keep the keydown match for `layers.paste` but stop calling `preventDefault` there; dispatch from `paste`, with a keydown fallback only when no `paste` event arrives within the same task. Add a regression test that the existing node-paste tests still pass.
- **URL fetch widens SSRF exposure (IMG-5).** Mitigation: route-level `studio.write`, the same guard as the MCP tool, a security-guard sign-off, and no loopback override.
- **Optimistic ghost on a non-active page (IMG-8).** Mitigation: activate the frame first, which is a documented decision. The existing `isPendingOptimisticNodeId` guard covers Delete during the window.
- **Import-mode misdetection (IMG-10).** Mitigation: public is the default; import mode only on a strict majority; Next is always public; the toast says which convention was used.
- **Dedupe hides an intended copy.** Mitigation: dedupe only within the same directory with identical bytes, where a copy has no meaning. `deduped:true` appears in the toast.

---

## SPEC B: "Detach component"

### B.0 What exists today (verified by reading)

- **Display inlining:** `src/core/page-parser/inlineLocalComponents.ts`. Each local component call site is **kept** as a `studio.instance` node (a React Fragment with zero DOM boxes, `src/modules/base/instance/`) whose id is the call site's real `rel:line:col` and whose `instanceOf.callSiteProps` are editable. The component's JSX is expanded as children with composite ids `callSiteId~componentNodeId` (`INLINE_ID_SEPARATOR`). The writeback target of an inner node is the tail, the component's own file, flagged `fromComponent`, and `SharedComponentNotice` shows the blast radius.
- **Codemod:** `src/core/ast-codemods/detachComponent.ts` (`detachComponentInstance`). It resolves the callee with `resolveComponentCallSite` (barrel- and rename-aware). It refuses on hooks, `.map` over a prop, an undestructured `props`, package components, unresolvable callees, and no JSX. It inlines the **chosen** branch (parser-06) with a `branchNote`, substitutes call-site **expressions** (never evaluated values), splices `{children}`, runs `addReconciledImports`, and drops the last-usage import.
- **Escape hatch:** `extractComponentCopy.ts` (`Card` becomes `Card2`, and this one call site is repointed).
- **Wire:** `kind:'detach'` in `server/handlers/studioWriteback.ts:357` / `studioEditSchemas.ts:239`. The client is `detachInstance(nodeId)` in `studio/studioSaveRequests.ts:247`, which does a full `requestCmsSiteReload()`.
- **UI:** a Detach button in `inspector/sections/ComponentSection.tsx:245` (disabled for package instances), with the refusal plus an Extract offer inline, and a "Detach this instance" remedy in the refusal dialog (`store/constraintActions.ts:138`). The e2e test is `tests/e2e/instance-selection-ui.e2e.ts`.
- **Corpus (eSIM, 139 instances):** 59 clean, 42 `uses-hooks` (mostly `useLanguage()`), 38 in `.map` rows with no single location.
- **Penpot semantics** (`generate-detach-instance`): detach is **one level**. The shape loses its component links, and **nested sub-instances stay instances** (promoted to roots). Studio's codemod matches this: sub-components referenced in the inlined JSX stay component calls with reconciled imports. Keep it that way.

### B.1 Correctness bugs in the shipped codemod

The codemod's header promises "fails closed". It does not, in these cases, and each one **writes broken or silently wrong source**:

1. **A param is substituted only when it is the whole `{expr}`.** `buildInlinedJsxText` substitutes only `JsxExpression` whose expression `isIdentifier`. Any other use of a param is left as a bare identifier in the page file:
   - `className={cn(styles.card, className)}`
   - `{featured && <Badge/>}`
   - `{title.toUpperCase()}`
   - `style={{ width: size }}`
   - `` href={`/p/${id}`} ``

   `referencedIdentifiers` also skips params (`!params.has(rootId)`) and ignores non-member roots, so nothing flags them. The result is either a `ReferenceError`/TS error, or, worse, **a silent rebind** to an unrelated same-named binding in the page (for example the page component's own `className` prop).
2. **An omitted prop with no default leaves `{paramName}` dangling.** The code calls this "a documented gap". The JS semantics are exact: an omitted prop **is** `undefined`. Substitute `undefined`, or drop an attribute whose whole value is that param.
3. **`name-collision` is declared but unreachable.** `DetachRefusalReason` includes it, and nothing returns it. `addReconciledImports` "trusts" any destination binding with the same name. For example, the page's own `styles` (Page.module.css) silently replaces Card's `styles` (Card.module.css), so the detached markup renders with the wrong classes. This is a direct violation of "one honest target".
4. **Component-body locals are dropped.** `const label = title.toUpperCase(); return <h2>{label}</h2>`: `label` is neither imported nor module-level, so `addReconciledImports` leaves it unbound.
5. **Call-site spread is ignored.** `<Card {...plan} />`: `callSiteAttributes` skips `JsxSpreadAttribute`, so every param fed by the spread becomes unbound.
6. **Component `...rest` is ignored.** `buildParamBindings` skips the rest element, so `<div {...rest}>` in Card becomes an unbound `rest`.
7. **`key` (and `ref`) are dropped.** Detaching a call site inside a `.map` template loses the `key` and produces a React warning plus reconciliation bugs.
8. **Defaults that reference the component's module scope** (`size = DEFAULT_SIZE`) are pasted as text but never scanned for imports.
9. **Output is un-idiomatic.** A string literal in child position is written as `{"Confirm"}` and in attribute position as `className={'neutral'}` (this is pinned by `detachComponent.test.ts:60,106`). "Edit anything freely" should give `Confirm` as JSX text and `className="neutral"`. These are cleaner to read and are the forms Studio's text and attribute editing handle natively.
10. **No undo.** Detach, swap and extract are not in the `store-14` source-gesture family (`docs/reference/editor-history.md:323,340` lists none of them). Cmd-Z right after a detach replays whatever entry came before it, against a reparsed tree. This is the same bug class `store-14` fixed for Cmd-D.

**The single structural fix for 1, 3, 4, 5, 6 and 8:** replace the text-level identifier heuristics with **symbol-based substitution plus a post-build free-variable gate**, reusing `subtreeFreeVariables.ts` (`analyzeFreeVariables` / `freeVariablesOutOfScopeAt`, which already power extract and transplant):

1. Substitute every `Identifier` in the chosen root whose **symbol** resolves to a destructured param declaration (`getSymbol()` compared with the binding element's symbol, which is shadowing-safe), in any expression position, with `(callSiteExpr)`. Wrap in parentheses only when the replacement is not a primary expression.
2. Collapse literal forms: a string literal in a JSX child becomes JsxText (when it has no `{}<>` characters); in an attribute initializer, `attr={"x"}` becomes `attr="x"`; an attribute whose value substitutes to `undefined` is removed.
3. Spread `{...X}` at the call site: a param `p` not explicitly set **after** the spread becomes `X.p`. An explicit attribute before the spread gives an ambiguous winner, which refuses as the new reason `spread-ambiguous`. A spread of a non-identifier expression refuses.
4. `...rest` in the component: the call site's attributes not consumed by named params are emitted as attributes at the `{...rest}` position. A spread at the call site combined with a rest refuses (`spread-ambiguous`).
5. Body locals: a `const` declared in the component body (non-hook, non-effect) that is **referenced** by the chosen JSX is **inlined as an expression** when it is used once and its initializer only references params and module scope. Otherwise refuse with the new reason `body-local`, which names the local and offers Extract.
6. **Gate:** run `freeVariablesOutOfScopeAt(inlinedRoot, callSite, pageFile)` against the *post-import-reconcile* page. Any name still unbound, or bound to a different declaration than in the component file, refuses with `unbound-reference` (naming it) or `name-collision`. **Nothing is saved on refusal.** Only then call `saveSync()`.
7. Collision handling that does not refuse: when a reconciled import's local name is taken by a different binding (for example `styles`), **alias it** (`import cardStyles from './Card.module.css'`) and rename the references inside the inlined text (symbol-based, so exact). Refuse only when aliasing is impossible (a global).

### B.2 Hooks: the biggest refusal class (42/139)

Refusing `useState` is correct. Most of the 42, though, are **context readers** (`useLanguage()`). A context reader's result is the same for every consumer under one provider, so moving the call from Card into the enclosing component changes nothing observable. The parser already traces this chain (Tier B: `useLanguage` to `useContext` to a single Provider).

Rule (DET-3):
- Allowed to move: a hook call whose arguments are empty or literal/module-scope only (**no param references**), whose result is destructured or bound to a `const`, and which is either `useContext(X)` directly or a local custom hook whose body is only `useContext` (+ `useMemo` of it). This is the same shape Tier B already recognises. Reuse its detector rather than writing a second one.
- Placement: the call moves to the **top level of the enclosing function component** of the call site, never at the call site, which keeps the rules of hooks.
  - If the enclosing component **already** calls the same hook with a compatible destructure, reuse its bindings: rename symbol-based if the local names differ, and add missing destructured keys to the existing pattern.
  - If the call site is not inside a function component (a module-level JSX const), refuse with `uses-hooks`.
- Everything else (`useState`, `useEffect`, `useRef`, arbitrary custom hooks) keeps refusing `uses-hooks`, with the Extract offer. **Do not hoist state.** One detached instance's state in the parent would re-render the whole page and change effect timing: a behaviour change sold as markup editing.

### B.3 Other cases, decided

| Case | Decision |
|---|---|
| Instance inside `.map` in source (a single call site template) | **Allow**, with the confirm text "This changes every row (N)". Carry `key` (bug 7) onto the inlined root. Where the source has one location, the "38 no-location" reason is about composite loop-row ids: resolve the row id to its template's `rel:line:col` in `studioEditLocation` for `detach` only. |
| Instance under a conditional (`{open && <Card/>}` / ternary branch) | Allowed. The replacement is the element, and the surrounding expression stays. |
| Component has multiple returns | Keep parser-06: inline the shown branch plus the `branchNote` warning, shown in a **pre-commit confirm** (not only an after-the-fact toast), because other states are lost. |
| Inlined JSX is a fragment or multiple roots | Fine as a replacement for a JSX child. If the call site is an attribute value or `return` position, a multi-root result is wrapped in `<>...</>`. |
| `className`/`style` merging | There is **no merging logic**. Symbol substitution makes `cn(styles.card, className)` become `cn(styles.card, "mt-4")`, exactly what the component computed. Optional fold (DET-6): when every `cn`/template argument is a literal, write the joined literal. Never fold anything else. |
| Sub-components / icons / assets / CSS modules | `addReconciledImports` with specifiers re-resolved against the page file, plus aliasing (B.1 step 7). Side-effect CSS imports in the component file (`import './Card.css'`) are **mirrored** too, since the detached markup's classes need that sheet. This is a new case in `importReconcile.ts`: bare imports are carried whenever the component file is the origin. |
| Detach several selected instances | One batch, applied **bottom-up by source position** in each file so earlier locations stay valid, giving one undo entry. **Verify** that `applyStudioEdit`'s batch ordering supports this before relying on it. If it does not, sort in the client and post N edits in one `/save` in descending order. |
| Package component | Stays refused, with the existing message. "Eject to local component" and "Replace with markup snapshot" remain the open WS-4.4 item and are **not** in this spec. |
| Nested instances inside the detached one | Stay instances (Penpot semantics). |

### B.4 Undo (DET-4): a CAS file-restore journal

No existing edit kind can carry a subtree's source text back. `editor-history.md:322` refuses source `delete` undo for exactly this reason. So add **one** generic mechanism rather than an inverse codemod per verb:

```ts
// Server: every one-shot codemod write (detach, swap, extract, and later source-delete) records
// .studio/undo-journal/<token>.json  { files: [{ rel, before: string, afterSha256: string }], at }
// (bounded: last 50 per project; Studio state on disk; never the user's app dirs)
// Response gains: { undoToken: string }
// New edit kind:
type RestoreEdit = { kind: 'restore'; token: string }
// Applies ONLY if every file's current sha256 === afterSha256 (compare-and-swap); else refuses
// 'restore-stale': "Card.tsx changed after the detach — undo would overwrite that change."
// Redo = the forward edit re-posted (store-14's existing `forward` field).
```

The client records a `source` history entry `{ inverse: [{kind:'restore', token}], forward: [{kind:'detach', nodeId}] }` through the existing `store-14` path (`structuralHistory.ts`, `commitStudioStructuralReissue`). The token is server-held, so the client never posts file text. That keeps the write surface to "revert Studio's own last write, only if untouched". The same mechanism later unlocks honest undo of source `delete`. Record that as a follow-up for store-engineer; it is not part of this order.

### B.5 UI

- **Context menus:** add "Detach instance" (and "Duplicate component and edit copy" on refusal) to `panels/DomPanel/LayerNodeContextMenu.tsx` and `canvas/CanvasLayerContextMenu.tsx`, shown only for `studio.instance` nodes with `source:'local'`, and disabled with a tooltip for package instances.
- **Shortcut:** Figma's Cmd/Ctrl+Alt+B as `layers.detachInstance` in `src/admin/spotlight/keybindings.ts`, plus a spotlight command in `spotlight/commands/layers.ts`, plus the `?`-sheet. `keybindings-registry-single-source.test.ts` must pass. The key is not taken today (checked the registry).
- **One dispatch path:** the button, the menu, the shortcut and the refusal remedy all call **one** store action, `detachInstances(nodeIds)`, in a new `store/slices/site/instanceActions.ts`. It replaces the direct `detachInstance` calls in `ComponentSection.tsx` and `constraintActions.ts`, so there is one place for the confirm, the undo entry, the refusal presentation and the post-reload selection. After the reload, select the detached root. The node id is known: it is the call site's own `rel:line:col` shifted by the import lines added, so return `detachedRootLoc` from the codemod.
- **Pre-commit confirm** only when something is lost: multiple branches, a `.map` template (N rows), or hooks moved. Plain detaches are instant, as in Figma.
- **Layers panel:** the icon change is free, because after the reparse the node is no longer `studio.instance`. No work needed.

### B.6 The "lighter alternative": local overrides

Option considered: "detached but still works", where the call stays and edits go to a local override.

- **Rejected as specified.** A hidden override layer (Studio-side data applied on top of the component) breaks disk-is-truth: the app would render differently from the canvas. Writing overrides into the call site as an `overrides={{...}}` prop breaks honesty, because the component does not accept it. Either way the write has no honest target.
- **The honest version is "Expose as prop" (DET-5), and it is recommended as a companion to detach, not a replacement.** On an inner node of an instance with a **literal** (text, a string attribute, a literal style value), the action "Override on this instance":
  1. adds an optional param to the component, `{ heading = 'Current text' }`, and replaces the literal with `{heading}`, so every other instance renders byte-identical because the default is the old literal. This is **unlike** `addSlotPropToComponent`, which drops content at non-passing sites;
  2. writes `heading="New text"` at this call site.
  Two files, deterministic, one gesture, zero blast radius, with `componentCallSites.ts` confirming the count. Refused when the component uses an undestructured `props` or when the literal is inside a `.map` over props. This is React's native form of a Figma instance override. It deserves its own Figma-parity line item after detach is hardened.

**Recommendation:** keep **inline detach** as *the* Detach verb. It is Figma's semantics (sever the link, edit freely), it is already built, and it matches Penpot's one-level detach. Fix it to truly fail closed (DET-1/2) before extending it (DET-3). Ship Expose-as-prop (DET-5) as the separate "override" feature. Do not build any override layer that is not source.

### B.7 Honest refusal cases (after this spec)

| Reason | When | Offer |
|---|---|---|
| `package-component` | the callee resolves to `node_modules` | none (WS-4.4 eject is open) |
| `uses-hooks` | any non-context-reader hook, or a context reader whose call site is not inside a function component | Extract copy |
| `maps-over-props` | the chosen JSX `.map`s over a prop | Extract copy |
| `unsupported-params` | undestructured `props` param | Extract copy |
| `spread-ambiguous` | call-site spread with an explicit attr before it, a non-identifier spread, or spread plus a component rest | Extract copy |
| `body-local` | a JSX-referenced body local that is not inlinable (used more than once, or its initializer depends on non-param body state) | Extract copy |
| `unbound-reference` | the post-build free-variable gate finds anything unbound (names it) | Extract copy |
| `name-collision` | a reconciled binding is taken and cannot be aliased (a global) | Extract copy |
| `no-renderable-jsx` / `unresolvable` / `not-a-component` | as today | none |
| `restore-stale` (undo) | the file changed after the detach | none (git panel) |

### B.8 Work orders

| id | Title | Files | Owner | Effort | Tests |
|---|---|---|---|---|---|
| **DET-1** | Make detach fail closed: symbol-based substitution everywhere, `undefined` for omitted, literal collapsing, free-variable gate, alias-or-refuse collisions, mirror side-effect CSS imports, carry `key` | modify `src/core/ast-codemods/detachComponent.ts` (delete `referencedIdentifiers` and the identifier-only `buildInlinedJsxText`, replaced by the symbol walk plus `analyzeFreeVariables`/`freeVariablesOutOfScopeAt`), `importReconcile.ts` (aliasing: `addReconciledImports` returns a rename map; bare side-effect imports), `subtreeFreeVariables.ts` (export what the gate needs), `server/handlers/studioEditSchemas.ts` (refusal kinds), `docs/features/studio-import.md` ("Detach and swap") | parser-surgeon | L | `detachComponent.test.ts` **updated** (the `{"Confirm"}`/`{'neutral'}` expectations become `Confirm`/`"neutral"`) + new cases: param in a call (`cn(...)`), in `&&`, in a template, in `style`; omitted prop with no default; `styles` collision gives an aliased import and correct classes; body local inlined vs `body-local` refusal; a module-scope default gets its import; side-effect CSS import mirrored; `key` carried; **every refusal leaves the file byte-identical** |
| **DET-2** | Spread and rest | `detachComponent.ts` (`buildParamBindings` records rest; `callSiteAttributes` records spreads in order) | parser-surgeon | M | spread gives `plan.title`; spread then explicit attr (the attr wins); explicit then spread gives `spread-ambiguous`; rest emits the leftover attrs |
| **DET-3** | Move context-reader hooks | `detachComponent.ts` + a shared detector extracted from the page-parser Tier B code (`src/core/page-parser/staticEval*.ts`, whichever file owns the provider trace, exported via the `@core/page-parser` barrel); enclosing-component locator in `jsxSubtree.ts` | parser-surgeon | M | `useLanguage()` detaches into a page that already calls it (bindings reused); one that does not gets the hook added at the top of the component; `useState` still refuses; a module-level JSX const refuses; re-measure the eSIM corpus and record it in `docs/features/studio-import.md` |
| **DET-4** | CAS restore journal + undo for detach/swap/extract | new `server/handlers/studio/undoJournal.ts`; modify `server/handlers/studioWriteback.ts` (journal the one-shot kinds; `restore` kind), `studioEditSchemas.ts`; client `studio/studioSaveRequests.ts` (return `undoToken`), `store/slices/site/structuralHistory.ts` + `historyTypes.ts` (a `source` entry for detach/swap/extract); `docs/reference/editor-history.md` table | server-engineer + store-engineer | M | `undoJournal.test.ts` (restore applies; restore after an intervening edit refuses `restore-stale` and writes nothing; journal bounded; paths contained under the project); `structuralHistory` test (Cmd-Z after detach posts `restore`; redo posts `detach`) |
| **DET-5** | One `detachInstances` action + context menus + Cmd/Ctrl+Alt+B + confirm + post-reload selection | new `store/slices/site/instanceActions.ts`; modify `inspector/sections/ComponentSection.tsx`, `store/constraintActions.ts` (call the action; delete the direct calls), `panels/DomPanel/LayerNodeContextMenu.tsx`, `canvas/CanvasLayerContextMenu.tsx`, `src/admin/spotlight/keybindings.ts`, `spotlight/commands/layers.ts`, `spotlight/keybindingGestures.ts`; `studioWriteback.ts` detach result gains `detachedRootLoc`; loop-row template resolution for `detach` in `studioEditLocation` | store-engineer + panel-designer | M | `keybindings-registry-single-source.test.ts`; `instanceActions.test.ts` (menu, button and shortcut dispatch identically; multi-select is one batch, bottom-up); **e2e**: extend `instance-selection-ui.e2e.ts` with Cmd+Alt+B, then Cmd-Z restoring the call site in the file |
| **DET-6** (optional) | Literal-only className fold | `detachComponent.ts` | parser-surgeon | S | `cn("a", "b")` gives `"a b"` only when every argument is a literal; otherwise untouched |
| **DET-7** (separate feature) | Expose-as-prop instance override | new `src/core/ast-codemods/exposeLiteralAsProp.ts` (+ `index.ts`), new edit kind in `studioEditSchemas.ts`/`studioWriteback.ts`, a Component-section and inner-node action in `panels/PropertiesPanel/SourceConstraintNotice.tsx` or `SharedComponentNotice` | parser-surgeon + panel-designer | M | every other call site renders byte-identical (default = old literal); refused for undestructured `props`; call-site count from `componentCallSites.ts` |

**Order:** DET-1, then DET-2, then DET-4, then DET-5, then DET-3, then (DET-6, DET-7). DET-1 goes first because every later step builds on a codemod that is currently allowed to write broken files. DET-4 goes before DET-5 so the shortcut ships undoable.

**Architecture gates:** none structurally new. `studio-routes-capability-declared.test.ts` is unaffected, because `restore` rides `/save`. If `instanceActions.ts` hosts a named tree mutation, it does not: it posts edits, like `imageDropActions`. So `no-vc-mode-branches-in-mutations.test.ts` is unaffected. `@core/page-parser` barrel exports for the Tier B detector (`no-core-barrel-deep-imports.test.ts` does not list page-parser, but use the barrel anyway).

### B.9 Risks

- **Symbol resolution cost:** detach already builds a workspace `Project` (`createWorkspaceProject`). Symbol queries on one component are cheap. Mitigation: none needed beyond reusing the one project per request.
- **Changing pinned test expectations (DET-1, item 9)** will look like a regression to a reviewer. Mitigation: the PR body states the literal-collapsing decision, and the `docs/features/studio-import.md` example is updated.
- **Hook moving (DET-3) misclassifies a stateful hook as a context reader.** Mitigation: the allowlist shape is exactly Tier B's recognised provider trace; anything else refuses. Corpus re-measure before merge.
- **The CAS journal grows or leaks source.** Mitigation: `.studio/` (already excluded from parse, zip and git-visible? **verify** that `.studio/undo-journal/` is gitignored or excluded from Studio's commit staging), bounded to 50 entries, pruned on project close.
- **Bottom-up multi-detach assumes batch ordering in `applyStudioEdit`.** Mitigation: verify first. If it is unsupported, the client sorts and posts descending, which is a known-safe order for same-file text edits.

---

## Delegate to

- **SPEC A:** server-engineer (IMG-1, 5, 10, 11), canvas-engineer (IMG-2, 3, 4, 5, 6, 7, 8, 9), store-engineer (IMG-3, 4, 7, 8), panel-designer (IMG-1, 6, 11), parser-surgeon (IMG-2, 10), security-guard (review IMG-1, 5, 11), test-engineer (e2e for IMG-2, 3, 8, 9).
- **SPEC B:** parser-surgeon (DET-1, 2, 3, 6, 7), server-engineer (DET-4), store-engineer (DET-4, 5), panel-designer (DET-5, 7), test-engineer (e2e for DET-5).
