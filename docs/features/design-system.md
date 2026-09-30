# Built-in design system
> **Purpose:** how Studio's own design system gets from `vendor/` onto the canvas, into a user's project, and into the Assets panel · **Read when:** touching `vendor/alm-design-system/`, the `alm.*` modules, a project's `design-system/` folder, the Assets panel or Add page · **Trust:** current · **Owner:** studio-scribe · **Verified:** 2026-09-23

Studio ships one design system as part of itself. Its source lives in this repository at `vendor/alm-design-system/`, Studio renders it from there at every trust tier with no install step, and every project that uses it carries a Studio-written copy in `<project>/design-system/`, so the user's repository builds and downloads standalone with only `react` and `vite`. The design system is not an npm dependency of Studio or of any project.

---

## TL;DR

| Layer | Where | What it does |
|---|---|---|
| Vendored source | `vendor/alm-design-system/` (`src/`, `dist/`, `studio/`, `CLAUDE.md`, `design.md`) | The only copy Studio renders from. `bun run alm:sync` builds the committed `dist/` and the component manifest |
| Canvas modules | `src/modules/alm/register.tsx` + `manifest.generated.json` | Registers each component as an `alm.<Name>` module with its prop truth and findability truth |
| Project copy | `server/handlers/studio/designSystemFiles.ts` (`ensureDesignSystemFiles`) | Writes `<project>/design-system/` from the vendored source; rewrites it only when the source hash changes |
| Parser | `src/core/page-parser/designSystemDir.ts`, `componentSources.ts` | An import from the project's `design-system/` folder resolves to `{ kind: 'design-system', name }`: a black-box component, never inlined as local source |
| Migration | `server/handlers/studio/designSystemMigrate.ts` + `DesignSystemMigrateBanner.tsx` | Moves a project that still imports the retired npm package onto the folder, on an explicit click |
| Assets panel | `src/admin/pages/site/panels/AssetsPanel/` | Everything insertable, as live-rendered cards with ranked search |
| Add page | `src/admin/pages/site/canvas/BoardFramesLayer/AddPagePicker.tsx` | The toolbar and notch `+`: create a Screen / Popup / Bottom sheet, or put a page that exists on disk back on the board |

The three owner decisions behind this shape (the project folder, everything insertable in Assets, the `+` as Add page) are BUILTIN §0.1–§0.3 in [`docs/decisions.md`](../decisions.md).

## The vendored package

`vendor/alm-design-system/` is wired into `package.json` as a `file:` dependency, the same way `vendor/pixel-art-icons/` is. `bun run alm:sync` (`scripts/sync-alm-design-system.ts`) produces the committed artefacts (`dist/index.js`, `dist/index.css`, `dist/tokens.generated.json`, `dist/BUILD_HASH`, and `src/modules/alm/manifest.generated.json`). What each one is, how the manifest's prop and findability truth are extracted, and the freshness gate are in [`modules.md`](modules.md) → "The built-in design system".

`vendor/alm-design-system/{CLAUDE.md,design.md,README.md}` are **data**: `src/core/design-system-manifest/vendorDocs.ts` parses their headings into the manifest. Do not restyle them or add a doc header to them. On a CRLF checkout the heading regex matches nothing; never run `alm:sync` on a CRLF tree (`.gitattributes` pins these files to LF).

## The project's `design-system/` folder

`ensureDesignSystemFiles(dir)` writes `src/index.js`, `components/`, `context/`, `tokens/`, `icons/LineIcons.jsx` and only the icon SVGs the source actually imports (found with a static regex; nothing is executed). `.studio/design-system.json` records a content hash and the written file list, so an unchanged source rewrites nothing and moves no mtimes. The folder carries a `README.md` saying it is Studio-managed, the same contract `prototype/*.generated.*` has. Pages import it relatively:

```tsx
import { Button } from '../design-system'
```

`isDesignSystemBacked(projectDir)` (`server/handlers/studio/builtinDesignSystem.ts`) is true when `<project>/design-system/index.js` exists. A project with the folder renders the canvas from Studio's vendored copy, not from the project's copy.

## Migrating a project off the retired package

A project written before the npm was retired still imports it and no longer builds. The load path changes nothing. `GET /admin/api/studio/design-system/migrate` reports what the board banner needs; the banner's button calls `POST`, which records `designSystem: 'alm'` in `.studio/meta.json`, writes the folder, rewrites every import of the retired package in the project's own source, and removes the dependency entry. It is a rewrite of the user's source, so it only happens when a person asks for it.

## The Assets panel and Add page

The Assets panel replaces the insert popup. Its sections, the live previews (`AssetPreview.tsx`, a shadow root carrying the vendor sheet so nothing reaches the admin cascade), the ranked search (`rankAssets.ts`), the Colors section and the favourites are described in [`docs/editor.md`](../editor.md) → "Left sidebar". A card inserts on click through `useInsertInserterItem`, and drags onto a frame (static or live) through `useCanvasInsertionDrag.ts`, which shows the drop line before release. The DOM panel's right-click `ModulePicker` reads the same `assetsModel.ts`, so the two surfaces agree about what is insertable.

Add page (`AddPagePicker.tsx`) is the one way a page joins the board: **New page** (the `PAGE_KINDS` from `@core/studio-board`) or **From files** (every page on disk that is not on the active board). See [`docs/editor.md`](../editor.md).

## Forbidden patterns

| Pattern | Use instead |
|---|---|
| Importing or declaring the retired npm package anywhere in `src/`, `server/`, `scripts/`, or showing it as live example code in a doc | The vendored `alm-design-system` package (Studio) or `'../design-system'` (a project). Gated by `src/__tests__/architecture/no-alm-npm-specifier.test.ts`; the one allowed spelling is the migration that rewrites it |
| Editing `<project>/design-system/` by hand | Change `vendor/alm-design-system/src/`, run `bun run alm:sync` on an LF tree, and let `ensureDesignSystemFiles` rewrite the folder |
| Parsing a design-system component's internals as local source | It is `{ kind: 'design-system' }`: one node whose props are editable at the call site |
| Adding a second insert surface with its own list of modules | Read `assetsModel.ts` |

## Limitations

- **The components are black boxes.** Studio edits their props at the call site; it does not edit a design-system component's own source.
- **Overlay components** (Dialog, BottomSheet and the other overlay shells) do not appear as Assets cards; they are page kinds under Add page.
- **A project's hand edits to `design-system/` are overwritten** the next time the vendored source changes.

## Related

- [`modules.md`](modules.md): the `alm.*` module pack, the manifest and `alm:sync`
- [`docs/editor.md`](../editor.md): the Assets panel, Colors and Add page UI
- [`prototype-export.md`](prototype-export.md): what a downloaded project contains
- [`trust-tiers.md`](trust-tiers.md): why the built-in system renders at every tier while third-party packages need Tier 1
- Source of truth: `vendor/alm-design-system/`, `server/handlers/studio/builtinDesignSystem.ts`, `server/handlers/studio/designSystemFiles.ts`, `src/modules/alm/register.tsx`
- Gate tests: `src/__tests__/architecture/no-alm-npm-specifier.test.ts`, `src/__tests__/architecture/alm-design-system-fresh.test.ts`, `src/__tests__/architecture/assets-search-coverage.test.ts`
