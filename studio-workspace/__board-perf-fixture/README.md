# Board perf fixture

**This is not user data.** Every un-prefixed directory under `studio-workspace/`
is a real (or test-seeded) user project — never delete or clear one. This one,
like `__canonical-fixture/`, is a small reference project committed as part of
the test suite; the leading `__` marks that distinction.

It exists so that `tests/e2e/studio-board-perf.e2e.ts` — the canvas perf gate
behind `bun run bench:studio-board` and CI's `e2e-budgets` job — has a board to
measure **on a clean checkout**. The spec used to target
`studio-workspace/maherfayad-stack-eSIM`, which is not tracked by git, so it
skipped itself on every CI run and on every machine but one (`verify-01`
finding 1, `STUDIO-FIGMA-FEEL-PLAN.md` §9).

## Why twelve frames, and not three

`src/admin/pages/site/canvas/BoardFramesLayer/frameMountPool.ts` keeps
`max(MIN_FRAME_POOL, onScreen + FRAME_POOL_HEADROOM)` = `max(8, onScreen + 4)`
frames mounted. **On a board of eight frames or fewer, every frame stays
mounted and there is no mount left to measure** — which is exactly why
`studio-feel.e2e.ts`'s zoom on the three-frame `test4` is a smoothness gate
rather than a mount gate (`tests/e2e/helpers/canvasPerf.ts` says so). Twelve
frames, laid out two to a row by `defaultFramePosition`'s grid, put enough
frames outside the opening viewport that a scripted zoom-out crosses a
virtualization boundary and mounts several frames *while the gesture is still
running*. That is the expensive case the budgets exist for.

## Layout

| Path | Purpose |
|---|---|
| `pages/Screen01.tsx` … `Screen12.tsx` | Twelve near-identical screens, ~28 elements each. Plain `.tsx` with a plain (non-module) CSS import — deliberately a different shape from `test4`'s CSS Modules and from the eSIM corpus's habits. |
| `pages/screens.css` | One shared stylesheet. Every live frame parses the project's stylesheets into its own document, so sharing one file is what makes twelve mounts cost the same thing twelve times. |
| `.studio/boards.json` | The board, with all twelve frames pinned at fixed grid positions — committed rather than seeded client-side so two runs measure the same layout. |
| `.studio/meta.json` | `pagesDir`, `frameDefaults` (1024×800), and a `displayName` that deliberately sorts AFTER `__canonical-fixture`'s so this project never becomes the workspace's default (`listStudioProjects` sorts by display name; `defaultProjectDir` takes `[0]`). |

## Keep it boring

The numbers this fixture produces are compared across runs and across commits.
Adding a frame, changing a screen's node count, or changing `screens.css`
changes every budget measured against it. If you need a different shape, add a
different fixture.
