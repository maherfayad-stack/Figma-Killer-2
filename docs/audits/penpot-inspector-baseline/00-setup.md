# 00 — Setup: self-hosted Penpot instance

Read this before the other files in this audit — it establishes exactly what
was running when every measurement and screenshot in this directory was taken.

## Source

Penpot's own self-hosting docs (`https://help.penpot.app/technical-guide/getting-started/#install-with-docker`)
point at the `docker-compose.yaml` published at the root of the Penpot repo
(`github.com/penpot/penpot`). That file was fetched fresh for this audit
rather than trusted from memory, per the work order's explicit instruction —
a prior unmerged branch (`fix/inspector-field-ergonomics`) had already guessed
wrong once about Penpot's numeric-field behavior (see `03-operating-behaviors.md`),
so nothing in this audit is taken on recollection.

## Resolved image tags (pinned, not `:latest`)

The compose file's images all resolve through a `PENPOT_VERSION` build arg
defaulted to `2.17.2`:

| Service | Image | Resolved tag |
|---|---|---|
| `penpot-frontend` | `penpotapp/frontend` | `2.17.2` |
| `penpot-backend` | `penpotapp/backend` | `2.17.2` |
| `penpot-exporter` | `penpotapp/exporter` | `2.17.2` |
| `penpot-mcp` | `penpotapp/mcp` | `2.17.2` |
| `penpot-postgres` | `postgres` | `15` |
| `penpot-valkey` | `valkey/valkey` | `8.1` |
| `penpot-mailcatch` | `sj26/mailcatcher` | `latest` (Penpot's own compose pins this one to `latest`; not a Penpot version and out of scope to re-pin) |

Confirmed against the running containers with `docker inspect <container>
--format '{{.Config.Image}}'` and cross-checked in-app: Dashboard → user menu
→ **About Penpot** reads **`2.17.2`** (see
`screenshots/../` any dashboard-adjacent shot; also visible directly via
`server.log`'s startup line `version="2.17.2"`). This is the version every
measurement, click count, and pixel value in this directory describes.

Per `STATE.md` `panel-20`'s decision (adopting plan §7 decision 3):
**"latest stable self-hosted, pinned at P0 run time."** `2.17.2` was Penpot's
latest published stable release at the time this compose file was pulled.

## Stack topology

Compose project name: `panel20-penpot`. Services actually started:
`penpot-frontend` (port `9001:8080`), `penpot-backend`, `penpot-exporter`,
`penpot-mcp`, `penpot-postgres` (internal only), `penpot-valkey` (internal
only), `penpot-mailcatch` (port `18080:1080`, for verifying registration
emails if needed — not used since `disable-email-verification` is set).

Relevant flags from the compose file's `x-flags` anchor:
`disable-email-verification enable-smtp enable-prepl-server
disable-secure-session-cookies enable-mcp`. `PENPOT_PUBLIC_URI` is
`http://localhost:9001`.

## Access

- URL: `http://localhost:9001`
- Registration is open (no invite required) because email verification is
  disabled for this local instance.
- Account used for this audit: `panel-baseline-2@studio.local` / team-less
  ("Your Penpot" personal space — `CONTINUE WITHOUT TEAM` on the onboarding
  flow), one file (`New File 1`) with four pages, one per fixture
  (`Page 1`…`Page 4`).
- **UI theme is a per-account setting**, not a URL param or local toggle:
  Dashboard → user menu (bottom-left avatar) → **Your account** → **Settings**
  → **UI THEME** → `Penpot Dark (default)` / `Penpot Light` / `System theme`.
  Switching it applies live to any already-open workspace tab without a
  reload. Every screenshot pair in `screenshots/<fixture>/{dark,light}/` was
  captured by flipping this setting and re-screenshotting the same
  selection — never by guessing colors from one theme and inverting them.
  Verified per-screenshot after the fact by sampling the right-panel
  background pixel: dark panel bg = `rgb(24, 24, 26)` (Inspect tab panel:
  `rgb(18, 18, 20)`), light panel bg = `rgb(255, 255, 255)` (Inspect tab:
  `rgb(250, 250, 250)`). See `02-measurements.md` for the full color table.
  **The canvas surface itself does not follow the UI theme** — it stays a
  light neutral gray (`#E8E9EA`-ish, exposed as the "Canvas background"
  setting on the page-level panel) regardless of light/dark chrome. Don't
  read canvas-area color as a theme signal; read the right panel.

## Tooling used to drive it

`gstack`'s `/browse` headless-browser CLI (`~/.claude/skills/gstack/browse/dist/browse`),
scripted via its `goto` / `click` / `fill` / `press` / `js` / `eval` / `screenshot`
commands. Two things worth recording for whoever repeats this:

1. **Draw-a-shape and move-a-shape gestures need synthetic `PointerEvent`
   sequences** (`pointerdown` → several `pointermove` → `pointerup`), not the
   CLI's plain `click`. The working pattern re-queries
   `document.elementFromPoint(x, y)` **on every `pointermove` step** and
   dispatches to that fresh target. A variant that dispatches every event to
   the *original* `pointerdown` target instead (mimicking real
   `setPointerCapture` semantics) reproducibly threw Penpot's own **"Something
   wrong has happened"** error toast whenever the drag crossed into a flex
   layout board's interior — reload recovers cleanly, no corrupted file state
   observed. Multi-select via synthetic shift+`PointerEvent` on the canvas hit
   the same error; shift+click dispatched as a plain `MouseEvent` on the
   **layers-panel row** (not the canvas shape) worked reliably and is what
   produced the mixed-value screenshots.
2. Drawing a shape *while already inside* a flex-layout board's bounds fails
   the same way; the reliable path is: draw the shape in free canvas space
   outside the board, then drag it (same working `pointermove`-requery
   pattern) into the board until Penpot's own layout engine reparents it —
   confirmed by the per-child **`FLEX ELEMENT`** panel replacing the
   free-shape **`CONSTRAINTS`** panel.
3. Keyboard shortcuts type into the currently-focused text field if one has
   focus — `Escape` first, or click an empty canvas area, before sending a
   tool shortcut like `r` for Rectangle. Penpot's Duplicate shortcut is
   `⌘D`/`Ctrl+D` **only when nothing has intercepted it**; the right-click
   context menu's `Duplicate` entry is the reliable trigger from automation.

## Teardown

**Confirmed torn down at the end of this task.** `docker compose down` was
run against the `panel20-penpot` project after every artifact below was
captured; `docker ps` no longer lists any `panel20-penpot-*` container.
Nothing about this audit depends on the stack staying up — every fact is
captured in this directory.
