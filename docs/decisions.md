# Owner decisions
> **Purpose:** every settled owner decision, with its date, source and consequence · **Read when:** before re-opening a product question, or when a work order cites a decision id (OD-n, D-n, FEEL §6.n, BUILTIN §0.n) · **Trust:** current · **Owner:** studio-architect · **Verified:** 2026-09-23

The product calls the owner has made, in one place, newest first. A decision recorded here is settled: do not re-open it in a work order, and do not build against its opposite. Open questions that still need the owner are in [`ROADMAP.md`](../ROADMAP.md), never here.

---

## TL;DR

- **The standing authorization holds** (2026-07-31, re-confirmed 2026-09-23): agents finish their bundle without stopping to ask, inside fixed limits (no push to `main`, draft PRs, no merges, security review where the plan says so).
- **Every project is Tier 2 (`run-project`) by default** (2026-09-20). How the tiers work: [`docs/features/trust-tiers.md`](features/trust-tiers.md).
- **The canvas excellence program's fourteen decisions** (OD-1…OD-14, OD-FC-1/2) are below; `ROADMAP.md` bundles cite them by id.
- Older decision sets are kept with their original ids (FEEL §6.n, BUILTIN §0.n, NEXT-WS Dn) because code comments and archived plans cite those ids. A superseded row says what replaced it.

| Id | Date | Topic |
|---|---|---|
| OD-1 … OD-14, OD-FC-1/2 | 2026-09-23 | The canvas excellence program ([below](#the-canvas-excellence-program-2026-09-23)) |
| Standing authorization | 2026-07-31, re-confirmed 2026-09-23 | [below](#the-standing-authorization) |
| Trust default | 2026-09-20 | [below](#every-project-starts-at-tier-2-2026-09-20) |
| FEEL §6.1 … §6.7 | 2026-09-17 | Figma-feel plan ([below](#figma-feel-plan-decisions-2026-09-17)) |
| BUILTIN §0.1 … §0.3 | 2026-09-17 | Built-in design system ([below](#built-in-design-system-2026-09-17)) |
| LIVE §7.1, §7.3, §7.4 | 2026-09-08 | Live canvas ([below](#live-canvas-2026-09-08)) |
| PROTO §1 | 2026-09-02 | Prototype links ([below](#prototype-links-2026-09-02)) |
| NEXT-WS D1 … D5 | 2026-08-01 | Agent, canonical JSX, preview axes ([below](#next-workstreams-2026-08-01)) |

---

## The canvas excellence program (2026-09-23)

Source: [`ROADMAP.md`](../ROADMAP.md) §2, answered by the owner on 2026-09-23. The owner answered OD-1, OD-2, OD-5, OD-7, OD-10/D1 and OD-14 in their own words (marked **owner**); every other row took the recommendation under the standing authorization.

| # | Decision | How it was settled |
|---|---|---|
| OD-1 | Old plans: **archive** the seven that code cites to `docs/archive/plans/`, filenames unchanged. Delete the three with no citations (`WAVE7-STATUS`, `BUILTIN-DESIGN-SYSTEM`, `CMS-REMOVAL`) after harvesting them. `STUDIO-SPEED-PLAN.md` is folded into `ROADMAP.md` §13 and archived too | **owner:** archive |
| OD-2 | The 2026-07-31 standing authorization ("run the whole plan without stopping to ask") stands. Limits: no push to `main`, PRs open as drafts, security-guard reviews what the plan marks for it | **owner:** re-confirmed 2026-09-23 |
| OD-3 | Keep Figma's meaning for ⌘K, F, ⌘⇧C, ⌘⇧G, ⌘I and ⌘-drag. **⇧-click on the canvas toggles**; range selection stays in the Layers panel | recommendation |
| OD-4 | The inspector gap between sections goes 8 → 12 px; merging Shadow + Blur into Effects pays for the height | recommendation |
| OD-5 | Insert tools R/O/T/F become **armed tools**: hover previews, a click places at the pointer, a drag sets the size, T starts typing. ⏎ keeps the keyboard insert | **owner:** yes |
| OD-6 | A marquee inside a frame starts on a press over the frame's root where no child is under the pointer. ⌘-drag stays free-move | recommendation |
| OD-7 | A structural gesture (move, delete, wrap, group, duplicate) on markup inside a **shared component** applies to **this instance only**, with no dialog: detach the instance, then replay the gesture, as one gesture and one undo. If detach refuses (a state hook, for example), make a component copy for this call site (`Card` → `Card2`) and replay there. Only when both refuse, show one honest refusal. **Value** edits (style, text) inside a component keep writing to the component, with the blast-radius notice | **owner:** "assume it's only this one" |
| OD-8 | A style or class edit on a `.map` row goes to the row template ("Applied to all N rows · Undo"). Reorder, delete or duplicate on a row edits the array literal | recommendation |
| OD-9 | **Detach** inlines the component's JSX at the call site (it still renders; props no longer apply; everything is editable), plus a separate **"Expose as prop"**. No hidden override layer | recommendation |
| OD-10 | SVG: D1 is superseded by OD-14 (a shape drawn on empty board goes to the free canvas; a shape drawn inside a frame lands in flow). D2: the pencil key is ⇧P, with ⇧C as an alias. D3: external `.svg` files are read-only, with "Inline to edit". D4: boolean ops are deferred. D5: the default stroke is `currentColor`, 2 px, round. D6: the real shape updates live during a drag | **owner:** D1 → free canvas; the rest recommendation |
| OD-11 | Assistant imagery: licensed stock search now; AI image generation later, behind its own capability and credential | recommendation |
| OD-12 | Image drop detects whether the project imports images or uses `public/` URLs. Public stays the default; Next.js is always public | recommendation |
| OD-13 | A URL dragged in from another browser tab gets an SSRF-guarded fetch route, with a security review | recommendation |
| OD-14 | **Free canvas.** The owner, verbatim: *"right in the canvas I want a free canvas that I can drag an element/component or an image in it and it's not part of the pages, and it's still there just not part of the live preview, so it's figma like free canvas"*. The empty board around the frames holds **loose layers**: elements, component instances, images and SVGs placed at any x/y. They persist across reloads and never appear in a page, the live preview or a publish. They can be dragged into a frame and out again. Each layer is one `.tsx` file at `.studio/canvas/<id>.tsx`; its position is stored in `boards.json`; all layers render in one shared static iframe per board. Design: [`docs/audits/2026-09-23-studio-audit/10-free-canvas.md`](audits/2026-09-23-studio-audit/10-free-canvas.md) | **owner:** new feature |
| OD-FC-1 | Loose layers do not sync through git, the same as `boards.json` | recommendation |
| OD-FC-2 | Loose layers paint below frames and lift above them while dragged | recommendation |

## The standing authorization

**Granted 2026-07-31; re-confirmed by the owner 2026-09-23 (OD-2).**

> Run the whole plan to completion without stopping to ask. Where a decision arises, take the recommended option, record it, and continue. Do not block on human confirmation. Every work order ends with a subagent-run test pass.

**Limits** (2026-09-23): never push to `main`; never merge a PR; open every PR as a draft; never force-push a branch you did not create; security-guard reviews every bundle `ROADMAP.md` marks for it. The authorization is an agent-workflow permission. It is not a user's consent to anything the product asks a human (see [`trust-tiers.md`](features/trust-tiers.md) → "Tier 2 is a product default, not a consent").

**The acceptance bar that came with it:** unit tests verify functions and cannot verify interactions (happy-dom has no layout engine and no real input pipeline). A canvas, frame, overlay, geometry or panel-height change is done when a browser pass drives real input and shows the user-visible result. `CLAUDE.md` → "Verification" states the rule and names the e2e gate.

## Every project starts at Tier 2 (2026-09-20)

Source: STATE `sec-19` ([`docs/state-archive/2026-09.md`](state-archive/2026-09.md)).

**Decision:** every Studio project starts at trust tier `run-project` (Tier 2). There is no promotion click and no automatic-promotion notice.

**Consequence:** `DEFAULT_TRUST_TIER = 'run-project'` in `server/handlers/studio/studioMeta.ts`. The 2026-09-17 mechanism (FEEL §6.2: a Vite project with a lockfile auto-promotes once, with a notice and an Undo) was deleted in the same change, including `LiveAutoPromoteNotice` and the `trustAutoPromoted`/`trustAutoPromotedAt` fields. The owner can still lower a project to `static` (the Live pill's "Back to static") and raise it again. Security reviews `sec-20` and `sec-21` narrowed what the default can run: the dev-server spawner starts a project only when its `dev` (else `start`) script is a `vite` invocation (`server/handlers/studio/liveCapability.ts`). Full description: [`docs/features/trust-tiers.md`](features/trust-tiers.md).

## Figma-feel plan decisions (2026-09-17)

Source: `STUDIO-FIGMA-FEEL-PLAN.md` §6 ([archived](archive/plans/STUDIO-FIGMA-FEEL-PLAN.md)).

| # | Decision | Consequence |
|---|---|---|
| FEEL §6.1 | **Yes**: grant `studio.run.project` behind Tier-2 promotion. Answers `STUDIO-FIGMA-PARITY-PLAN.md` §15.1 | Work order A10 closed `sec-05` finding 1: `studio_render_reference` needs both the connector capability and `trust === 'run-project'` (`server/handlers/studio/trustGate.ts`, gated by `src/__tests__/architecture/studio-tier2-two-gates.test.ts`) |
| FEEL §6.2 | **No prompt, promote**: a Vite project with a lockfile is promoted to Tier 2 on first open, once, with a notice and an Undo | **Superseded 2026-09-20** by the Tier-2 default above |
| FEEL §6.3 | GitHub sign-in: **device flow with a PAT fallback** | G2 as specced (`docs/features/studio-git.md`) |
| FEEL §6.4 | **Yes**: gitignore `studio-workspace/*` except a named sample list, and `prototype/*.generated.*` inside kept projects | Work order Z9: `.gitignore` rules plus `git rm --cached` of the committed generated files |
| FEEL §6.5 | **Defer** non-Vite live frames | The Live pill says "Live needs Vite" (`liveCapability.ts`'s `not-vite`) |
| FEEL §6.6 | **Yes**: ⌘-drag may write `left`/`top` inline for an already-absolute element or inside a relative parent | K6 as specced (`docs/reference/canvas-dnd.md` → "Free movement (K6)") |
| FEEL §6.7 | **Document "single operator" now; gate every route in a follow-up wave** | Z10 wrote the posture into `docs/server.md`; `sec-14` then gated every Studio route (`server/handlers/studio/routeCapabilities.ts`, `CLAUDE.md` → "Studio routes are declared, not guarded") |

## Built-in design system (2026-09-17)

Source: `STUDIO-BUILTIN-DESIGN-SYSTEM-PLAN.md` §0 (deleted after harvest; in git history). How the result works: [`docs/features/design-system.md`](features/design-system.md).

| # | Decision | Consequence |
|---|---|---|
| BUILTIN §0.1 | A project imports the built-in components from a **Studio-written `<project>/design-system/` folder**, relatively (`import { Button } from '../design-system'`), not from the retired `@alm-design/design-system` npm | The downloaded repo builds with `react` + `vite` alone. Gated by `src/__tests__/architecture/no-alm-npm-specifier.test.ts` |
| BUILTIN §0.2 | Base elements, saved layouts and saved components move into the **Assets panel** too; the insert popup is deleted | `src/admin/pages/site/panels/AssetsPanel/` |
| BUILTIN §0.3 | "The plus" is the toolbar `+`: it becomes **Add page**, and the Explorer's two page pluses merge into the same picker | `src/admin/pages/site/canvas/BoardFramesLayer/AddPagePicker.tsx` |

The plan also kept the `alm.<Name>` module id prefix (ids are minted at parse time from source, so a rename buys nothing).

## Live canvas (2026-09-08)

Source: `STUDIO-LIVE-CANVAS-PLAN.md` §1 and §7 ([archived](archive/plans/STUDIO-LIVE-CANVAS-PLAN.md)).

| # | Decision | Consequence |
|---|---|---|
| LIVE §1.1 / §7.1 | Live frames run on a **separate origin** (a second port on the same host), driven by an in-frame runtime bridge over `postMessage`. A same-origin proxy was rejected because the user's code would run with the admin session cookie | `server/liveOrigin.ts`; see [`live-canvas.md`](features/live-canvas.md) |
| LIVE §7.3 | The inspector is rebuilt to a measured Penpot baseline, pinned at self-hosted Penpot 2.17.2 | `docs/audits/penpot-inspector-baseline/` |
| LIVE §7.4 | Order: P0+P1 and L1–L4 in parallel, then L5 alone | Historical |

LIVE §7.2 (the promote prompt) was superseded by FEEL §6.2, which was itself superseded on 2026-09-20.

## Prototype links (2026-09-02)

Source: `STUDIO-PROTOTYPE-PLAN.md` §1 ([archived](archive/plans/STUDIO-PROTOTYPE-PLAN.md)).

**Decision:** a prototype link is a **design layer, never the user's source**. Studio does not write `onClick` handlers into `.tsx` files to author a link. **Consequence:** links live in `.studio/prototype.json`; code-derived flows are read, drawn read-only, and never persisted. See [`studio-prototype.md`](features/studio-prototype.md) → "Where an authored link lives, and why".

## Next workstreams (2026-08-01)

Source: `STUDIO-NEXT-WORKSTREAMS.md` "Decisions taken" ([archived](archive/plans/STUDIO-NEXT-WORKSTREAMS.md)).

| # | Decision | Consequence |
|---|---|---|
| D1 | The four workstreams land as sequential commits on `feat/alm-figma-killer-studio-shell` | **Superseded.** The branch model now is `ROADMAP.md` §4: bundle PRs target the program trunk `feat/canvas-excellence`; `main` is protected and reached by PR only (`CLAUDE.md`) |
| D2 | The canvas chat authenticates **per user, not per machine**: each user gets an isolated CLI environment (`CLAUDE_CONFIG_DIR`) and logs in with their own Claude account | `docs/features/agent.md` |
| D3 | **One agent scope: Studio.** The CMS scopes come out of the application | `docs/features/agent.md` |
| D4 | Generated subagents live in `<project>/.claude/`, committed | They travel with the user's repository |
| D5 | The canonical-JSX validator reports and never blocks; `.tsx` is the scaffold default; dark-mode tokens stay single-valued; preview axes persist per project; the agent may **ask** for trust promotion and never performs it; `studio_create_page` auto-places the frame; bypass mode stays non-persisting, indicated and trust-bound | `docs/reference/canonical-jsx.md`, `docs/features/agent.md` |

Also recorded in that plan, and still the product stance: **Studio optimises for authoring, not for making any one imported corpus render.** Reading arbitrary third-party React is best effort.

---

## Related

- [`ROADMAP.md`](../ROADMAP.md): open work and open owner questions
- [`docs/features/trust-tiers.md`](features/trust-tiers.md): the trust model these decisions shaped
- [`docs/archive/`](archive/): the plans these decisions were made in
- [`docs/agent-refs/handoff-protocol.md`](agent-refs/handoff-protocol.md): how a new decision is recorded (a STATE entry names it; the scribe adds a row here)
