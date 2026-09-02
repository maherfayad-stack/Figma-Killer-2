# Studio

**A design tool whose source of truth is your React repo.**

Open a real React project — hand-written or pulled from GitHub — as an infinite
board of live, editable frames. Move things, restyle them, retype the copy, swap
a component. Every edit is written back into the actual `.tsx` files as a
precise AST change. There is no export step and no code generation: the
repository *is* the document.

---

## What makes it different

Most visual builders own the data and emit code. Studio inverts that.

| | Typical visual builder | Studio |
|---|---|---|
| Source of truth | The tool's database | **Your repo, on disk** |
| Getting code out | "Export" / codegen | There is nothing to export — it edits the files |
| Round-tripping | One-way, lossy | Edit in the editor or in your IDE, both directions |
| What renders | The tool's approximation | **Your components, your CSS, your DOM** |

The canvas renders each frame in its own `<iframe>` with a real `<html><body>`,
so your combinators, percentage height chains, viewport units, and cascade all
behave exactly as they do in the browser — no wrapper `<div>`s, no selector
rewriting, no scoping.

---

## How it works

```
studio-workspace/<project>/       a real React repo
        │
        ▼   ts-morph static parse — never executes your code
  ParsedPage tree                 local components inlined, values statically
        │                         resolved, .map over static data expanded,
        │                         imported CSS read into a class registry
        ▼
  Board canvas                    one iframe per frame, pan/zoom, Figma-style
        │
        ▼   you edit a prop, some text, a style, a tag
  Typed edit batch
        │
        ▼   AST codemods
  Your .tsx files, rewritten in place
```

Two rules hold the whole design together:

1. **Parse, never execute.** Everything on the canvas was read out of the AST by
   a bounded evaluator with explicit, documented tiers — not by running your app.
2. **A write must have exactly one honest target.** If an edit can't land in
   exactly one place in your source without destroying a binding or silently
   changing N call sites, the editor refuses it and says why.

---

## Quick start

```sh
bun install
bun run dev            # http://localhost:5173
```

Then open the editor with Studio mode on:

```
/admin/site?studio
```

Projects live in `studio-workspace/<project>/`. Create one from the Overview
launcher, or import a repo from GitHub. A project can carry a `.studio/meta.json`
sidecar pointing at its real screens directory:

```jsonc
{
  "displayName": "eSIM Journey",
  "pagesDir": "src/screens",
  "previewAxes": { "direction": "ltr", "colorScheme": "light", "locale": "en" }
}
```

---

## Stack

**Bun** runtime · **TypeScript** everywhere · **React 19** with the React
Compiler enabled · **Vite** · **Zustand + Mutative** for editor state ·
**ts-morph** for parsing and codemods · **TypeBox** at every untyped boundary ·
CSS Modules with design tokens.

Studio is built on a forked CMS. That subsystem — Postgres/SQLite, the
publisher, plugins, content workspaces — is still present and load-bearing for
the editor shell, but it is not what this product is. See
[`PROJECT-BRIEF.md`](PROJECT-BRIEF.md).

---

## Documentation

| Start here | |
|---|---|
| [`PROJECT-BRIEF.md`](PROJECT-BRIEF.md) | **Read first.** What the project is, current state, traps, task routing. |
| [`CLAUDE.md`](CLAUDE.md) | The rule book — conventions every change must follow. |
| [`STATE.md`](STATE.md) | Live coordination board for work in flight. |
| [`STUDIO-IMPORT-V2-PLAN.md`](STUDIO-IMPORT-V2-PLAN.md) | The roadmap for everything not yet built. |
| [`docs/README.md`](docs/README.md) | Full documentation index. |
| [`docs/agent-refs/`](docs/agent-refs/) | Compressed references written for coding agents. |

Deep dives worth knowing about:
[`docs/features/studio-import.md`](docs/features/studio-import.md) (the parser
contract) and
[`docs/features/canvas-iframe-per-frame.md`](docs/features/canvas-iframe-per-frame.md)
(how the canvas renders).

---

## Commands

```sh
bun run dev            # full stack (SQLite at .tmp/dev.db, no external deps)
bun run build          # tsc -b && vite build
bun test               # unit + architecture gate tests
bun run lint           # eslint, incl. React Compiler rules
bun run bench          # performance benchmarks
bun run test:e2e       # Playwright
```

---

## License

MIT — see [`LICENSE`](LICENSE).
