# Owner decisions
> **Purpose:** every settled owner decision, with its date, source and consequence · **Read when:** before re-opening a product question, or when a work order cites a decision id (OD-n, D-n, FEEL §6.n, BUILTIN §0.n) · **Trust:** current · **Owner:** studio-architect · **Verified:** 2026-09-23

The product calls the owner has made, in one place, newest first. A decision recorded here is settled: do not re-open it in a work order, and do not build against its opposite. The one exception is the "Proposed — owner to confirm" section, whose rows are recommendations awaiting an answer. Other open owner questions are in [`ROADMAP.md`](../ROADMAP.md).

---

## TL;DR

- **The standing authorization holds** (2026-07-31, re-confirmed 2026-09-23): agents finish their bundle without stopping to ask, inside fixed limits (no push to `main`, draft PRs, no merges, security review where the plan says so).
- **Every project is Tier 2 (`run-project`) by default** (2026-09-20). How the tiers work: [`docs/features/trust-tiers.md`](features/trust-tiers.md).
- **Figma parity program (2026-10-10):** OD-17, OD-19, OD-21, OD-22 and SB-D1..D3 are decided; the rest of its questions are proposed and not settled.
- **The canvas excellence program's sixteen decisions** (OD-1…OD-16, OD-FC-1/2) are below; `ROADMAP.md` bundles cite them by id.
- Older decision sets are kept with their original ids (FEEL §6.n, BUILTIN §0.n, NEXT-WS Dn) because code comments and archived plans cite those ids. A superseded row says what replaced it.

| Id | Date | Topic |
|---|---|---|
| OD-17, OD-19, OD-21, OD-22, SB-D1…3 | 2026-10-10 | **Decided**: the Figma parity program ([below](#figma-parity-decided-2026-10-10)) |
| OD-18, OD-20, OD-23, OD-24, SB-D4…7, OD-P1…7, CT-OD, CV-OD, OD-MP | 2026-10-10 | **Proposed, not settled**: the Figma parity program ([below](#proposed--owner-to-confirm-2026-10-10)) |
| OD-1 … OD-16, OD-FC-1/2 | 2026-09-23 (OD-15, OD-16: 2026-09-24) | The canvas excellence program ([below](#the-canvas-excellence-program-2026-09-23)) |
| Standing authorization | 2026-07-31, re-confirmed 2026-09-23 | [below](#the-standing-authorization) |
| Trust default | 2026-09-20 | [below](#every-project-starts-at-tier-2-2026-09-20) |
| FEEL §6.1 … §6.7 | 2026-09-17 | Figma-feel plan ([below](#figma-feel-plan-decisions-2026-09-17)) |
| BUILTIN §0.1 … §0.3 | 2026-09-17 | Built-in design system ([below](#built-in-design-system-2026-09-17)) |
| LIVE §7.1, §7.3, §7.4 | 2026-09-08 | Live canvas ([below](#live-canvas-2026-09-08)) |
| PROTO §1 | 2026-09-02 | Prototype links ([below](#prototype-links-2026-09-02)) |
| NEXT-WS D1 … D5 | 2026-08-01 | Agent, canonical JSX, preview axes ([below](#next-workstreams-2026-08-01)) |

---

## Figma parity: decided (2026-10-10)

Source: the plans in [`programs/`](programs/), answered by the owner on 2026-10-10 and relayed by the coordinating agent. The rest of that program's questions are still open, in "Proposed — owner to confirm" below.

| # | Decision | How it was settled |
|---|---|---|
| OD-17 | Moving an element that uses state (`useState`/`useReducer`/`useRef`) gives it its own copy of that state, with a notice and Undo. The original keeps its own | **owner:** yes |
| OD-19 | Editing a value (text, attribute, inline style) inside a shared component changes only that instance by default. This amends OD-7's second sentence. Mechanism per [`programs/refusals.md`](programs/refusals.md): an auto-added optional prop whose default is the current value, and an "Apply to all (N)" action | **owner:** yes |
| OD-21 | Design-system (`alm.*`) components can be detached as local code. This also settles the detach question STATE `meta-20` left open; real `node_modules` packages keep refusing | **owner:** yes |
| OD-22 | Inserting into a component keeps detaching it, with a one-line notice. **Exception:** when the component accepts elements through a slot (`children` or a `ReactNode` prop, for example a layout component), the insert lands in that slot at the call site and nothing is detached | **owner:** yes, refined |
| SB-D1 | The live-frame cap is **adaptive**: keep as many screens live as the machine can afford. Default 20, scaling up with available memory and the measured live-frame budget (for example `navigator.deviceMemory` and the live-frame heap measurement), never below 12. Frames beyond the cap, or below the zoom threshold, are posters | **owner:** "overall the more screens the better" ("10–20 is a safe bet") |
| SB-D2 | A bitmap poster is acceptable for screens the user is not editing; it refreshes on idle | decided by delegation (plan recommendation) |
| SB-D3 | Editing a node on a poster frame auto-promotes it to live (wait of at most 250 ms); the zoom threshold below which a frame is a poster is 0.35 | decided by delegation (plan recommendation) |

---

## Proposed — owner to confirm (2026-10-10)

Source: the five plans in [`docs/programs/`](programs/), indexed by [`ROADMAP.md`](../ROADMAP.md) §14. **Nothing in this section is settled.** "Provisionally adopted" means a bundle already in flight assumes the recommendation; if the owner answers differently, that bundle changes. "Open" means no in-flight bundle depends on it. An id here moves into a dated settled section when the owner answers. The board-speed plan numbers its questions D1..D7; they are written `SB-D1..SB-D7` here so they do not collide with NEXT-WS D1..D5.

### Refusals ([`programs/refusals.md`](programs/refusals.md))

| # | Question | Recommendation | Status |
|---|---|---|---|
| OD-18 | Does a move carry props and `.map` row values? | Yes: bake the resolved literal as a named `const` at the destination; a function, JSX or object-ref prop that cannot be serialized still refuses, naming it. A row element moved out of a template is a copy of that row | open |
| OD-20 | Typing into a code-bound field replaces the binding with the literal? | Yes, with an info notice and Undo; the field stays read-only with an "Unbind" button otherwise | open |
| OD-23 | Detach hoists state hooks into the enclosing component when the call site is hook-legal? | Yes, with fresh names per instance; otherwise the component-copy fallback runs | open |
| OD-24 | "Unroll list" as an explicit, lossy, menu-only action? | Yes | open |
| Brief-1 | Amend [`PROJECT-BRIEF.md`](../PROJECT-BRIEF.md) invariant 2 (needed by OD-17, OD-18, OD-20). Proposed sentence, to be added by the owner or on their go-ahead: "a write has one honest target, or one named consequence the user is shown and can undo" | Adopt after OD-17/18/20 are answered. The brief is **not** changed until then | open |

### Board speed ([`programs/board-speed.md`](programs/board-speed.md))

| # | Question | Recommendation | Status |
|---|---|---|---|
| SB-D4 | Persist posters to `.studio/cache/posters/` (gitignored, LRU-capped)? Cap size? | Yes, default 500 MB, per project, never uploaded | open |
| SB-D5 | Tier-2 posters: rasterize inside the dev-server document, or from the static fallback? Cap of 3 live bridge frames? | Inside the dev-server document (runtime-side, only where Tier 2 already runs); cap 3 | open |
| SB-D6 | Rasterizer path | Studio-owned foreignObject serializer on the board; revisit if a browser-native HTML-in-Canvas API proves available | open |
| SB-D7 | WebGL scene | Not now: 2D canvas first; revisit only if SB-6 measures more than 4 ms at 300 frames | open |

### Positioning ([`programs/positioning.md`](programs/positioning.md))

| # | Question | Recommendation | Status |
|---|---|---|---|
| OD-P1 | Free frame detected from computed style, or marked in source? | Derived, no marker | provisionally adopted (PA-1, PA-2) |
| OD-P2 | Ignore auto layout / cmd-drag when the auto-layout parent is static: refuse with remedy, or write `position:relative` on the parent? | Auto-write in the same undo step when the parent's style site is single and unshared; refuse with a remedy otherwise | open |
| OD-P3 | Frame selection on in-flow members | Bare `<div>`, members unchanged; only absolute members get a positioned wrapper; never freeze flow children into pixels | open |
| OD-P4 | Drawing in a plain flow (block) frame | Keep flow insert; cmd places freely | provisionally adopted (PA-3 scope) |
| OD-P5 | A fifth "Free" layout-mode button? | No: a derived chip plus Add/Remove auto layout menu items | open |
| OD-P6 | Default unit for a newly absolute layer | px; % only through the Scale constraint | open |
| OD-P7 | Modifier key for free placement | Keep cmd/ctrl (already shipped); no Alt (Alt means copy) | provisionally adopted (PA-2) |

### Components and tokens ([`programs/components-tokens.md`](programs/components-tokens.md))

| # | Question | Recommendation | Status |
|---|---|---|---|
| CT-OD-1 | Source of truth for tokens | The project's own CSS custom properties plus Tailwind v4 `@theme`; Studio's Framework scales stay a separate generator, shown as a read-only "Framework" collection | provisionally adopted (CT-1, CT-2) |
| CT-OD-2 | Modes | Inferred from existing selectors (`[data-theme]`, `.dark`, `@media`); "+ Mode" writes a gate block, reusing the detected colour-scheme gate, else `[data-theme="<name>"]` | provisionally adopted (CT-1 gate classification); the "+ Mode" write is open until CT-4 |
| CT-OD-3 | Text and effect styles | Text style is a CSS class; effect style is a `--shadow-*` token | open |
| CT-OD-4 | Renaming a token | Rewrites every `var()` use in project source in one undo step, with "Updated N uses · Undo"; refuses when a use is in package or compiled source | open |
| CT-OD-5 | Editing a read-only token (package, vendor, Framework, ALM) | Offer "Override in <entry stylesheet>"; never edit the package | open |
| CV-OD-1 | Which patterns are writable variants | css-module class map, `data-*` attribute selector, lookup object, cva/tv, boolean class; everything else is `opaque` (renders, refuses Add variant with the line number) | open |
| CV-OD-2 | Where the main component lives on the board | A derived "Components" frame group opened from Assets, separate from curated boards (needs scout verification that a definition root can be selected with a writable id) | open |
| CV-OD-3 | "Add variant" | Clones the currently shown member's styling; an empty variant is a second button | open |
| CV-OD-4 | Removing or renaming a variant member or prop that call sites use | Refuse and list the sites; never rewrite N call sites silently | open |
| CV-OD-5 | Design-system (`alm.*`) and package components | Call-site properties only, no Add variant | open |
| OD-X | Ordering | Ship tokens (CT-1..CT-4) before variant writes (CV-3/CV-4) | open |

### Multiplayer ([`programs/multiplayer.md`](programs/multiplayer.md))

| # | Question | Recommendation | Status |
|---|---|---|---|
| OD-MP-1 | CRDT or server-ordered ops | Server-ordered ops; refuse on structural conflict | open |
| OD-MP-2 | Transport | One WebSocket for presence and notifications; writes stay HTTP | provisionally adopted (MP-1) |
| OD-MP-3 | Who sees presence | Viewers yes; share-link guests only on comment-capable shares, as anonymous "Guest N"; no new capability, reuse `site.read` | viewers: provisionally adopted (MP-1); guests: open |
| OD-MP-4 | Same-prop conflict | Silent last-writer-wins plus an info chip, not a blocking prompt | open |
| OD-MP-5 | Undo scope | Per-user, hunk-level, never undoes a peer's change; refuses with a name when a peer touched the region | open |
| OD-MP-6 | Soft locks | Advisory rings only; no hard element locks in v1 | open |
| OD-MP-7 | Agent visibility | The agent is a named member with its current target, visible to the room | open |
| OD-MP-8 | Git verbs while others edit | Allowed, busy chip, saves queue behind the lock | open |
| OD-MP-9 | Room size | Max 12, soft warning at 8 | provisionally adopted (MP-1) |
| OD-MP-10 | Deployment | Single instance per project; high availability deferred | provisionally adopted (MP-1) |
| OD-MP-11 | Phasing | Ship presence (MP-1, MP-2) as its own release before touching the write path | open |

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
| OD-15 | Arrows after a **Layers** pick: a pointer click on a Layers row hands the keyboard to the canvas, so the arrows nudge / reorder the layer (P2-C's `canvas.moveSelection`) and every canvas shortcut acts on it; keyboard entry into the tree (Tab) keeps ↑/↓ as row navigation; text fields keep their caret | **owner:** 2026-09-24, "like Figma" |
| OD-16 | **Bulk actions on a multi-selection.** The owner, answering P2-C's "multi-select nudge / reorder do nothing": *"it should allow bulk actions yes also"*. Every canvas action that makes sense on many layers acts on the whole selection as ONE gesture and ONE undo entry: arrows nudge every absolute layer by one delta and step flow children along their own parents (a mixed selection nudges its absolute layers and leaves flow children put); ⌥↑/⌥↓ and ⌘[/⌘] step the whole selection; ↑/↓ on a grid child move one row (the resolved column count). A step the source cannot write as independent single-element moves (a grid-row step of 2+ layers, one moving layer inside another's path) refuses by name. Multi-select drag, paste and wrap stay with P3-D | **owner:** 2026-09-24 |

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
