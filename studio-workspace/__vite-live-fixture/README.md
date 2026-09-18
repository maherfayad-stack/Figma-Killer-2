# `__vite-live-fixture` — the smallest project Studio auto-promotes to Tier 2

`STUDIO-FIGMA-FEEL-PLAN.md` §6 decision 2: **a Vite project with a lockfile is
promoted to `run-project` on first open — once, ever — with a visible Undo.**
That is the one place in Studio where the trust tier moves without a human
clicking anything, so it is the one place where a regression is silent by
construction: nothing on screen changes when a gate stops being checked.

This project exists so `tests/e2e/studio-feel-phase0.e2e.ts` can drive that
promotion against real bytes on disk. Every file here is the minimum
`server/handlers/studio/liveCapability.ts` needs to answer `{ capable: true }`:

| file | why it is here |
|---|---|
| `vite.config.js` | `resolveProjectProfile` reports `framework: 'vite'` only when it finds a `vite.config.*` — the first of the two conditions. |
| `index.html` + `src/main.jsx` | the profile also needs an ENTRY (`index.html`'s `<script type="module">`, or a conventional `src/main.*`); without one it reports `vite-entry-not-found` and the framework is not `vite`. |
| `bun.lock` | the second condition. `LOCKFILES` checks for presence only — a dev server with no resolved dependency set either fails to boot or boots against whatever is lying around, and a lockfile is the cheapest honest proxy for "installed at least once, on purpose". Its CONTENT is never read by anything. |
| `package.json` | makes this directory the app root (`detectAppRoot` stops at the first `package.json`), which is where the lockfile is looked for. |
| `src/pages/Home.jsx` | one page, so the board has a frame. `.jsx`, not `.tsx`, on purpose — `genericRepoShapes.test.ts`'s rule: a fixture that shares every habit with the eSIM corpus tests the corpus, not the parser. |

## What is deliberately NOT here

**`node_modules/`.** Committing an installed dependency tree into this
repository is out of the question (`.gitignore`'s studio-workspace section:
"the missing rule cost 140,894 committed lines"), so the dev server this
project is allowed to start cannot actually boot here. The promotion, the
notice, the Undo and the once-only latch are all observable without it — they
are file-and-DOM facts. The LIVE FRAME half is not, and the phase-0 spec marks
that case `test.fail()` naming this paragraph as the reason.

## Do not rename it

`listStudioProjects` sorts by `displayName` and `defaultProjectDir` takes the
first entry, so the project a fresh Studio opens with is whichever sorts first.
`"Vite Live Fixture"` sorts last among the four tracked fixtures, which is the
point: this one is auto-promoted on open, and a project that is auto-promoted
on open must never be the one a developer gets by accident.
