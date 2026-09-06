# STUDIO — Wave 4–6 plan: the big rocks, then the truth pass

Work orders for the four engine projects, five expansion features, and the final
repo-hygiene wave left open by the 2026-09-06 five-track audit, written for subagents. Each section is a self-contained
work order: goal, mechanism, file-level tasks, refusal policy, tests, and what NOT to
do. Waves 1–3 (PRs #4–#9 + in-flight) covered everything smaller; do not re-solve
anything listed there.

**How to use this file:** one agent per § (W4-4 is phased — one agent per phase).
The orchestrator pastes the relevant § into the agent prompt together with the
global rules below. An agent given a § reads the named files before writing code;
line references are from the audit date and drift — grep, don't trust.

---

## Global rules for every wave-4/5 agent

1. **Base branch.** `git fetch origin && git checkout -b <branch> origin/main` unless
   the § names a different base. Wave 4 must start only after the wave-1–3 PRs that
   own its files have merged (per-§ "Prereqs" row) — otherwise you are editing a file
   another unmerged PR rewrites.
2. **Never `git stash`.** The stash stack is shared across all worktrees and parallel
   agents' pops race (this destroyed two agents' trees on 2026-09-06, recovered via
   `git fsck`). To A/B a change, `cp` to `.tmp/<area>/` or commit WIP and reset.
3. **All repo conventions apply**: TypeBox at boundaries, no manual memoization,
   tokens-only CSS, no wrapper elements in canvas DOM, `refuseStructuralEdit`-style
   honest refusals, docs updated in the same change, `STATE.md` handoff at the end.
4. **Delivery**: draft PR, conventional title, no agent-branded branch prefixes,
   stage only your files, `bun run build && bun test && bun run lint` at the end,
   triage pre-existing failures (icon-catalog-integrity, claudeCli suites,
   projectMcpApprovals) as not-yours. UI changes flag "needs human dogfood".

---

# W4-1 — Reparent, duplicate, wrap (~1 day)

**Goal.** The last three Figma verbs that refuse. `sourceStructure.ts` states the
blocker plainly: "the new element would have no source location of its own, so it
could never be written back." Insert already solved exactly this — it writes the
element into the `.tsx`, then re-reads the board so the node comes back as a real
parsed node with a real source id. Generalize that write-then-re-read pattern.

**Prereqs.** `feat/constraint-refusal-ui` merged (it owns `structuralSourceEdits.ts`
and renders `EditConstraint` — your changes retire two of its refusal messages);
`fix/style-writeback-correctness` merged (shares `fsCodemodAdapter.ts` save path).

**The machinery that already exists** (read all of these first):
- `src/core/ast-codemods/jsxSubtree.ts` — extract a subtree's source text
- `src/core/ast-codemods/jsxChildRange.ts`, `locateJsxElement.ts` — positions
- `src/core/ast-codemods/insertJsxElement.ts` — the write-then-re-read precedent
- `src/core/ast-codemods/moveJsxElement.ts` — sibling reorder (extend, don't fork)
- `src/core/ast-codemods/importReconcile.ts`, `pruneOrphanedImports.ts`
- `src/core/ast-codemods/subtreeFreeVariables.ts` — the honesty check: what a
  subtree captures from its scope
- `src/core/page-tree/sourceStructure.ts` — the refusals you are lifting (~148–176)
  and `refusePlacement`, which stays
- `server/handlers/studio/reloadScope.ts` + narrow reload — the re-read after write

**Design.**

- **Duplicate**: `jsxSubtree` text of the node → insert as next sibling via the
  `insertJsxElement` mechanics → narrow reload. Same-scope copy means captured
  bindings (`subtreeFreeVariables`) remain valid by construction — no new imports
  needed. REFUSE (keep honest): `.map`-expanded rows, nodes with no writable source
  location, `base.slot-instance` roots, package-instance internals.
- **Wrap**: replace the subtree's source range with `<Wrapper>…subtree…</Wrapper>`;
  wrapper is a plain `div` in v1 (a design-system wrapper needs the module-pack
  import — reuse the insert flow's import writing if cheap, else v2). Note: the
  "no wrapper divs" trap is about the CANVAS inventing DOM the source doesn't have;
  a wrapper written INTO the source becomes real DOM and is legitimate — say this
  in a comment where you lift the refusal. REFUSE: multi-select wrap across
  different parents (v2), fragments-with-siblings edge cases you can't range.
- **Reparent**: extend `moveJsxElement` from same-parent reorder to cross-parent
  move **within the same file** in v1. The moved subtree's `subtreeFreeVariables`
  must all still be in scope at the destination — check statically, refuse with the
  variable names when not. Cross-FILE reparent stays refused (message updated to
  say "different file" instead of a blanket no).

**Tasks.**
1. Codemods: `duplicateJsxElement.ts`, `wrapJsxElement.ts`, extend
   `moveJsxElement.ts` with a destination-parent form. Fixture tests per codemod
   in `src/core/ast-codemods/__tests__/` covering comments, multi-line props,
   fragments, self-closing, and the refusal branches.
2. Wire kinds `duplicate` / `wrap` / `reparent` into the `StudioEdit` batch schema
   (`server/handlers/studioWriteback.ts` dispatch) and the client collector
   (`structuralSourceEdits.ts`), following the existing `insert` flow including its
   post-write narrow reload.
3. Lift the three refusals in `sourceStructure.ts` behind the new capability;
   keep `refusePlacement` verdicts. Update `editConstraint.ts` copy/actions for
   what remains refused. **Move the gate test** if one asserts the old refusals.
4. Store: the mutations `duplicateNode` / `wrapNode` / `moveNode` already exist as
   tree-agnostic mutations — do NOT add vc-mode branches (gated). The change is in
   what the source-structure layer permits, not in the mutation API.
5. Docs: `docs/agent-refs/studio-pipeline.md` §writeback, PROJECT-BRIEF "works
   today" bullet.

**Definition of done:** duplicate/wrap/reparent land on disk on the eSIM corpus
(`studio-workspace/esim-journey`) via the save path, refusals for the excluded
shapes still fire with accurate sentences, `bun test` green on your files.

---

# W4-2 — Headless agent capture + warm CLI session (~1 day)

**Goal.** Kill the two biggest fixed costs in every agent turn: (a) visual
verification is hostage to the user's open tab (8–12 s waits per frame, hijacks
their viewport, 90 s timeout on a wedged tab); (b) every turn cold-spawns `claude`
and re-handshakes every MCP server.

**Prereqs.** PR #9 (`fix/ai-loop-latency`) and `feat/agent-diagnostics-and-routing`
merged; base on main after both.

**Part A — headless capture.**
- Read `server/ai/mcp/tools/studio/referenceRender.ts` — it already boots a real
  browser (and, at Tier 2, the project's dev server). Read
  `src/admin/pages/site/agent/studioExportFrames.ts` + `AgentSnapshotFrame` — the
  deterministic offscreen render that exists browser-side today.
- Design: a dedicated capture route — `/admin/agent-capture?token=…&pageIds=…` —
  that mounts ONLY the snapshot frames (no editor shell, no board), authenticated
  by a short-lived single-purpose capture token minted server-side (follow
  `mcp/sessionConnector.ts`'s turn-token pattern; never a session cookie).
  A server-side headless browser (reuse referenceRender's plumbing, which is
  Tier-agnostic for THIS use — rendering Studio's own parse output executes no
  project code, so no `studio.run.project` gate; state that reasoning in the
  handler doc comment) loads the route and screenshots each frame.
- `studio_screenshot` / `studio_export_frames` / `studio_compare` route: headless
  first, live-bridge fallback (some things only the live tab knows — selection,
  in-progress edits; keep the bridge path for those and say when each is used in
  the tool descriptions).
- Definition of done: `studio_compare` on a 5-page board completes with the editor
  tab CLOSED. The user's open tab is never scrolled/zoomed by a capture.

**Part B — warm CLI session.**
- Read the deferral note at `server/ai/drivers/claudeCli.ts` (~63–78): the
  `--input-format stream-json` stdin shape "was never verified" — verifying it IS
  the task. Spike first: hand-drive `claude -p --input-format stream-json
  --output-format stream-json` in a scratch dir, confirm the message envelope for
  a second turn, THEN build.
- Keep one subprocess per conversation: reuse across turns; regenerate the MCP
  config/connector only when capabilities or approved servers changed (guide
  regeneration is already manifest-gated). Kill + cold-respawn on: model change,
  permission-mode change, idle > N minutes, process death mid-turn (fallback to
  today's cold path — keep it, it's the crash recovery, not a shim).
- Definition of done: second turn of a conversation starts streaming with no
  subprocess spawn and no MCP `initialize` in the server log; a killed process
  degrades to cold spawn without user-visible error.

---

# W4-3 — Git integration: commit / branch / PR as Studio's publish verb (~1 day)

**Goal.** The source of truth is a real repo with zero VCS awareness — every
codemod is an unattributed working-tree mutation and a designer cannot ship.
v1 = status, diff, branch, commit, push; PR creation link-out.

**Prereqs.** None hard; merges cleanly beside wave-1–3 work. New surface.

**Design.**
- Server: `server/handlers/studio/git.ts` — `Bun.spawn` the system `git`, cwd
  locked to the workspace root through the existing containment guard (study how
  `installDeps.ts` + `subprocessRunner.ts` bound their subprocesses — same
  discipline: no shell interpolation, args array only, workspace-relative paths
  validated server-side, never the Studio host repo itself). Routes: GET status
  (porcelain v2, parsed to TypeBox), GET diff (per file, unified), POST branch
  (create/switch — switching triggers a full board reload, warn in UI), POST
  commit (message + explicit file list — never `-A`), POST push (only when an
  `origin` remote with credentials exists; surface stderr honestly on auth
  failure), GET log (recent commits for the history view). A project without
  `.git` gets a "Initialize git" affordance (git init + initial commit, confirm
  dialog).
- Client: a Source Control panel (new `panels/GitPanel/`, rail entry): changed
  files (pair `git status` with `turnWriteLog.ts` so agent-authored changes are
  labeled), per-file diff view (CodeMirror is already the repo's code-view
  primitive — use its merge/diff addon), commit box, branch switcher, push button
  (Button `loading` state from wave 3). Restore-file-from-commit = checkout single
  file + board reload, behind a danger-styled confirm.
- Agent: `studio_git_commit` MCP tool, capability-gated the way `site_publish` is
  (explicit grant, never default) — commits the turn's write-log files with the
  agent's message; nothing else.
- **Safety rails (non-negotiable):** never `push --force`, never `reset --hard`,
  never `checkout` across branches with a dirty tree without an explicit
  user-confirmed decision (offer commit-first), never any git command outside the
  workspace root. Refusals name the reason.

**Definition of done:** import a repo → edit on canvas → see the change in the
panel diff → commit on a new branch → push (against a test remote) — all without
leaving Studio. Version history follows near-free: the log view + file restore IS
v1 history.

---

# W4-4 — CSS-in-JS (2–3 days, phased — one agent per phase)

**Goal.** The largest "which repos work" gap: styled-components/emotion projects
are detected (`styleToolchainDetect.ts` sets `cssInJs`; `canonicalCheck.ts` warns)
and then render unstyled. Do NOT attempt full fidelity in one pass — ship phases.

**Phase A — static extraction → render (Tier 0, ~1 day).**
- In the parser (ts-morph is already holding the AST): recognize
  `styled.div\`…\``, `styled(Component)\`…\``, and emotion's `css\`…\`` where the
  template has **no interpolations, or only interpolations the static evaluator
  already resolves** (Tier A/B constants, theme tokens resolved through the
  existing evaluator). Emit each as a `StyleRule` with a synthetic class in the
  compiled-origin registry (exactly how Tailwind-compiled rules present: visible,
  read-only — wave 2's pre-flight writability then grays them for free) and
  attach the class to the component's rendered nodes via `node.classIds`.
- Templates with unresolvable interpolations (`${p => …}`): resolve the DEFAULT
  branch when the evaluator's branch-selection machinery can pick one
  (`branchSelection.ts` precedent), otherwise drop those declarations and record
  the loss in the fidelity report (`canonicalCheck.ts` finding, upgraded from the
  blanket warning to per-declaration honesty).
- Fixtures: add a styled-components fixture to the parser test corpus; measure
  the extraction rate on a real OSS styled-components repo and record it in the
  handoff (the instance work set the precedent: a measured % beats a claim).

**Phase B — writeback (~0.5–1 day).** Value edits to a declaration that lives in
a resolvable template: a new codemod `setStyledDeclaration.ts` that locates the
declaration inside the template literal's quasi text (postcss can't parse a
template with holes — do offset math against the raw quasi, reuse
`setStringLiteral`'s single-origin discipline) and rewrites the value in place.
Everything else — new declarations, renames, interpolated values — REFUSES with a
named reason. Wire into the `collectStyleRuleEdits` plan as a new edit kind.

**Phase C — emotion object styles + `css` prop (~0.5 day).** Object-literal
styles are ordinary AST — easier than templates: read via the evaluator, write
via `setJsxProp`-grade property edits. Same refusal discipline.

**Sequencing note.** Phase A alone is most of the user-visible value (styled
repos stop rendering naked). Ship it independently.

---

# W5 — Expansion features (½–1 day each)

## W5-1 Prototype-mode finish
`STUDIO-PROTOTYPE-PLAN.md` is the spec — phases 2–5. Do not respec here; the
agent reads that file. Footholds already live: `server/handlers/studio/
{prototypeRoutes,prototypeStore}.ts`, `src/core/studio-anchor/`,
`.studio/prototype.json`, parser `codeFunctionPaths`. Phase 5 (read real
`onClick` navigation into read-only flow connectors) is the differentiator —
prioritize it if phases must be cut.

## W5-2 Share / preview links
v1 = static snapshot share. Server: mint a share token per board
(`.studio/shares.json`, revocable), export frames server-side (depends on
**W4-2 Part A** — sequence after it), serve a read-only page at
`/share/<token>`: board layout + frame images + page names, zero editor code,
zero auth beyond the token. Comments integration (viewers leave comments via the
existing `commentsRoutes.ts`) is v1.5. Definition of done: a logged-out browser
renders the shared board; revoking the token 404s it.

## W5-3 Storybook / CSF import
Discover `*.stories.@(tsx|ts|jsx)` (CSF3: default export meta + named story
exports). Each story = component + args → parse through the existing pipeline
(`extractManifest.ts` already extracts prop surfaces) and scaffold one board
frame per story via the `pageScaffold.ts` + `boardFrames.ts` auto-place path.
Stories are real files — nodes get real source ids, and story `args` edits write
back via `setJsxProp` on the story object. This also fixes the insert-picker
cold-start: every story component gets a call site. Refuse render-function
stories with logic (parse-never-execute still holds); measure the clean-import
rate on a real OSS Storybook and record it.

## W5-4 Deploy integration
Sequence after **W4-3** (deploy without commit is a footgun). Tier-2-gated
(`studio.run.project`): run the project's own build via `subprocessRunner.ts`,
then hand off to the Vercel/Netlify CLI if configured in the workspace (detect
`vercel.json`/`netlify.toml`; never store provider tokens in Studio — use the
CLI's own auth state and say so in the UI). v1 = "build + deploy preview from
current branch, show the URL". Capability + confirm dialog; agent gets no deploy
tool in v1.

## W5-5 Animation editing
The write path exists (`insertRule.ts` explicitly supports `@keyframes`;
`CanvasAnimationInjector.tsx` freezes with `freezePoint: 'end'|'start'`). Build
the surface: an Animations section (inspector real estate — coordinate with the
disclosure plan's section registry) listing the animations affecting the
selected node, with duration/easing/delay edits (existing declaration writes) and
a keyframe editor that writes new `@keyframes` via the insert path. A "scrub"
control drives the existing freeze injector's progress. JS animation
(framer-motion/GSAP) stays out — that's the W8.1 freeze gap, a different fix.

---

# W6 — The truth pass: clean the repo until it describes itself (~1 day, LAST)

**Goal.** After waves 1–5 merge, the repo's words must match its code. Today they
don't: the audit found PROJECT-BRIEF listing eight shipped features as unbuilt,
CLAUDE.md carrying a dead entry point, five plan files in various states of
completion, and a STATE.md at 5–6× its protocol size. This wave runs **after
everything else merges** — a truth pass over an unmerged tree documents a state
that never existed. One agent per numbered task; 1–3 can run in parallel, 4–5
after them.

**W6-1 Plan-file retirement.** Audit every root `STUDIO-*.md` against the tree:
- A plan whose deliverables all shipped is DELETED (git remembers — the repo's own
  rule), after folding any still-load-bearing rationale into the matching
  `docs/features/*` or `docs/agent-refs/*` page. Candidates to verify, not assume:
  `STUDIO-IMPORT-V2-PLAN.md` (superseded by the parity plan's ledger),
  `STUDIO-INSPECTOR-DISCLOSURE-PLAN.md` (done once PR #5 + stacked PRs merge),
  `STUDIO-COMMENTS-PLAN.md`, and this file's completed sections.
- A plan still driving work stays (`STUDIO-PROTOTYPE-PLAN.md` until W5-1,
  `STUDIO-CMS-REMOVAL-PLAN.md` until executed, `STUDIO-NEXT-WORKSTREAMS.md`'s
  open workstreams).
- Every doc that pointed at a deleted plan gets its link retargeted — grep, don't
  hope. `STUDIO-FIGMA-PARITY-PLAN.md` §0a remains the single status ledger; say
  so wherever a deleted plan used to claim that role.

**W6-2 STATE.md archival.** The handoff protocol caps "Recently landed" at ~10
entries; it holds ~58 (~9,000 lines). Archive the overflow to
`docs/state-archive/2026-Q3.md` (or the protocol's own convention if it names
one — read `docs/agent-refs/handoff-protocol.md` first and follow it exactly),
keeping every entry a durable fact still references. This is the PR the wave-1
docs agent explicitly deferred because it collides with concurrent appends — run
it in a quiet window, rebase immediately before merge.

**W6-3 Rule-book and identity accuracy.**
- `CLAUDE.md`: the two stale claims the docs agent flagged and could not touch —
  the `/admin/site?studio` entry point (no `?studio` param exists; the editor
  renders unconditionally) and invariant 1's "until that ships, it holds
  absolutely" (trust tiers shipped; rewrite to describe the Tier 0/1/2 reality).
  Sweep the rest of CLAUDE.md against the tree while in there.
- `README.md`, `package.json` `name`/`description`, `index.html` meta: one
  product name (**Studio** — PR #8 set the precedent), descriptions that describe
  a design tool over a real React repo, not a CMS.
- `.claude/agents/README.md` roster: verify the fourteen agent descriptions still
  match what each specialist actually owns after the wave-1–5 file moves.

**W6-4 docs/ sweep.** Walk `docs/README.md`'s index end to end: every page either
(a) describes the current tree, (b) is corrected in this PR, or (c) is a
CMS-half page — and for (c), follow `STUDIO-CMS-REMOVAL-PLAN.md`'s disposition
for it (delete/keep/rewrite) rather than inventing one. `docs/agent-refs/
path-index.md` must reflect every file moved or deleted by waves 1–5 (the
dashboard dialog move, the dead-panel deletions, new GitPanel/capture routes).
Glossary gains the new vocabulary (trust tiers, capture token, share token).

**W6-5 Dead-code sweep.** After all merges: `npx fallow dead-code` (canonical),
`knip` as second opinion; delete unused exports/files the waves orphaned. Run
`bun run fallow:health` and record the before/after in the PR body. Anything a
gate test enumerates (icon catalog, § allowlists) gets its gate updated in the
same commit — that's the convention, not drift.

**Definition of done:** a fresh agent given only PROJECT-BRIEF.md + STATE.md +
docs/agent-refs/ can orient without hitting a single claim the tree contradicts.
That was the audit's core finding about docs debt; this wave closes it.

---

## Sequencing & conflict matrix

| Order | Item | Blocks on | Owns (conflict-relevant) |
|---|---|---|---|
| 1 | W4-2A headless capture | PR #9 + diagnostics PR merged | server/ai/mcp/tools, new capture route |
| 1 | W4-3 git v1 | — | new server/handlers/studio/git.ts, new GitPanel |
| 1 | W4-4A CSS-in-JS extraction | — | page-parser, styleRegistry compiled-origin |
| 2 | W4-1 reparent/duplicate/wrap | constraint-UI + style-writeback PRs merged | ast-codemods, sourceStructure, structuralSourceEdits |
| 2 | W4-2B warm CLI | W4-2A (same area) | claudeCli.ts |
| 2 | W5-1 prototype, W5-3 Storybook | — | prototype*, pageScaffold |
| 3 | W4-4B/C CSS-in-JS writeback | W4-4A + style-writeback merged | css writeback plan, new codemod |
| 3 | W5-2 share links | W4-2A | new share route |
| 3 | W5-4 deploy | W4-3 | subprocessRunner consumers |
| 3 | W5-5 animation editing | inspector PRs merged | inspector section registry, insertRule consumers |
| 4 | W6-1/2/3 truth pass (parallel) | ALL code waves merged | root *.md, STATE.md, CLAUDE.md, README |
| 4→5 | W6-4/5 docs sweep + dead code | W6-1..3 merged | docs/**, orphaned exports, gate tests |

Rows with the same order number can run as parallel agents — their file sets are
disjoint. Never run two rows that share a column-3 entry. W6 is strictly last:
a truth pass over an unmerged tree documents a state that never existed.
