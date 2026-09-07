# Studio sample project

A three-page React app, offered from the Overview launcher's empty state as
"Start with the sample project". It is not a template gallery entry and it is
never created automatically — a user has to ask for it.

It exists so a first-time user has something real to open: a project with more
than one screen, plain JSX, co-located CSS Modules, and no dependency Studio
has to install before the board can draw it.

## What it deliberately is

- **Three pages, not one.** `Home`, `Pricing` and `Signup`. One page cannot
  demonstrate a board, and the prototype-mode onboarding step needs two frames
  to draw a link between.
- **`react` and nothing else.** Every other dependency would be a package that
  has to be installed before the project builds — and Studio copies, it never
  installs (see `server/handlers/studio/projectSeed.ts`).
- **Tier-0 safe.** No build step, no config file, no postinstall. Studio parses
  these files with ts-morph; nothing here ever runs on the user's machine
  unless the user runs it.
- **CSS Modules, co-located.** The same shape `pageTemplates.ts` scaffolds, so
  an agent reading this project continues the convention Studio itself writes.

## Copying it

`server/handlers/studio/sampleProject.ts` copies this directory into
`studio-workspace/<name>/` and writes the new project's `.studio/meta.json`,
including `sample: true` — the marker that lets the launcher say a sample can
be thrown away without ceremony. Nothing in this directory is a `.studio/`
sidecar: the meta is written by the copy, so there is one place that decides
what a fresh sample's meta says.

## Editing it

This tree is a user's React project, not Studio's source. It is excluded from
`tsconfig`'s program and from ESLint (`eslint.config.js`'s `globalIgnores`) for
the same reason `studio-workspace/` is: Studio parses this code, it does not
build or lint it. Keep it plain, keep it small, and keep the dependency list at
exactly one.
