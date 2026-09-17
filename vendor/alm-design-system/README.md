# alm-design-system (vendored)

The ALM design system, **vendored into Studio**. This folder is the only copy
Studio renders from — there is no `@alm-design/design-system` npm dependency
any more.

## Where it came from

`https://github.com/tajawal/design-system` @ `c35fc3c` — the exact source of
`@alm-design/design-system@1.1.2`. Copied from that repo's `src/`, not from a
published tarball, because the npm ships only a bundle.

Deliberately **not** copied: `mcp/` (its MCP server, whose `zod` dependency is
banned repo-wide), `scripts/`, `docs/`, `public/`, `*.figma.tsx` (Figma Code
Connect), `Button2.placeholder`, `App.jsx` / `main.jsx` / `App.css` and
`src/assets/` (the upstream demo app). The vendored `package.json` therefore
has **no** `dependencies` — only `react` / `react-dom` peers.

## Layout

| Path | What it is |
|---|---|
| `src/` | The **source of truth**. 40 `.jsx` components + their CSS, `context/`, `tokens/`, `icons/` (568 SVGs + `LineIcons.jsx`). Edit here. |
| `dist/index.js`, `dist/index.css` | **Generated.** A Vite lib build of `src/index.js`, committed. Studio's admin bundle imports this, never `src/`, so the 40 `import './X.css'` side effects and the `?raw` SVG imports never reach the admin document. |
| `dist/tokens.generated.json` | **Generated.** Every `--color-*` / semantic custom property in `src/tokens/*.css` as `{ name, light, dark, group }`. |
| `dist/BUILD_HASH` | **Generated.** SHA-256 over every build input, so the freshness gate can check `dist/` without a full Vite build. |
| `studio/keywords.json`, `studio/groups.json` | **Studio's own curation** — search synonyms and the Assets-panel grouping. Kept beside the upstream files, never inside them. Hand-edited. |
| `CLAUDE.md`, `design.md` | Upstream docs, verbatim. They are the source of the generated component manifest's prop specs, descriptions and keywords. |

## Editing

Edit `src/`, `studio/keywords.json` or `studio/groups.json`, then run:

```sh
bun run alm:sync
```

That rebuilds `dist/` and regenerates `src/modules/alm/manifest.generated.json`.
`src/__tests__/architecture/alm-design-system-fresh.test.ts` fails if you forget.
