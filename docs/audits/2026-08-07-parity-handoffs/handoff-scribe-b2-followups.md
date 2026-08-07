# studio-scribe — B2 className-writeback follow-ups — handoff

## Task 1 — `server/ai/mcp/tools/studio/editTools.ts`

Verified against the actual code before writing anything (`setJsxClassName.ts`,
`ClassEditSchema` in `studioEditSchemas.ts`, the `case 'class'` dispatch and
`isRefusingEditKind` in `studioWriteback.ts`) rather than paraphrasing the
brief.

- `ApplyEditsInputSchema`'s `edits` field description: kind list now reads
  `prop|text|style|class|literal|tag|asset|detach|swap|insert|delete|move|css`.
- `applyEditsTool.description`: "Six VALUE kinds" → "Seven VALUE kinds …
  prop, text, style, class, literal, tag, asset". Added a paragraph naming
  the `class` kind's exact wire shape (`{ kind: "class", nodeId, add:
  string[], remove: string[] }`), explicit that `add`/`remove` are class
  NAMES never `sc-<hash>` ids, what it writes (bare literal, expression-
  wrapped string/template, `cn`/`clsx`/`classNames`/`classnames` calls — ADD
  merges into a literal arg or appends one, REMOVE strips a token from every
  literal arg, best-effort on a token reachable only through a non-literal
  arg), and its five named refusals verbatim from `ClassNameRefusalReason`
  (`css-module-binding`, `template-dynamic`, `unsupported-call`,
  `spread-attribute`, `unsupported-expression`) with one clause each on when
  it fires. Also states the no-op case (every add/remove token already
  applied → silent success, no refusal).
- `refusals lists WHY any detach/swap/delete/insert/move/css edit…` →
  added `class` to that enumeration (confirmed via
  `StudioEditRefusal['kind']` in `studioWriteback.ts:482-491`, which already
  includes `'class'`).
- "never for the six single-line value kinds" → "seven", to match.

Verified: `./node_modules/.bin/eslint server/ai/mcp/tools/studio/editTools.ts`
clean; `bun test server/ai/mcp/tools/studio/editTools.test.ts` — 11 pass, 0
fail (no test asserts the literal description string, so nothing else needed
updating there). Did not touch `editTools.test.ts` — no test coverage gap
was introduced by this change (description-string-only edit).

## Task 2 — `docs/features/studio-import.md`

**TL;DR bullet (was line 23).** Replaced the false "nothing is ever written
back to a `.css` file" claim — false on two counts, not one: (a) the
`CSS write-back (WS-6.3, panel-02)` section two sections down already
documents that plain hand-authored `.css` DOES write back via `kind: 'css'`
(this was stale *before* B2, not introduced by it — the TL;DR bullet and the
detailed section below it contradicted each other even before this task);
(b) the "separate feature" framing for `className` is what B2 just falsified.
New bullet states both write paths (rule declaration vs. element attribute)
and links to both sections by their real headers.

**The flagged line (was `docs/features/studio-import.md:693`).** Corrected
in place, in the section's existing voice: the "no mapped `.css` source"
refusal now reads as a *permanent* fact about rule declarations (there is no
stylesheet line to rewrite, ever — this was never really "a separate feature
away", the sentence just conflated two different write targets), with a
forward pointer to the new subsection for the element-level fix.

**New subsection**, `### \`className\` write-back (Track B2, \`setJsxClassName\`)`,
inserted directly after the existing CSS write-back section (same `##`
parent, `## Imported CSS`), covering: the wire shape (`ClassEditSchema`),
the shape table (absent / plain literal / expression-wrapped string-template
/ dynamic template ADD-only / join-call), the five named refusals with their
triggers, the no-op-is-silent behavior, the reorder-writes-nothing-by-design
behavior (cascade order isn't token order), and a closing line connecting it
to `classAssignmentUnsavedNotice.ts`'s now-narrower toast (verified by
reading that file directly — its own doc comment already described the
post-B2 scope accurately, so I matched it rather than inventing new framing).

Every claim in the new subsection was checked against the actual source,
not the B2 handoff's prose:
- `src/core/ast-codemods/setJsxClassName.ts` — read in full for the shape
  table and refusal triggers.
- `server/handlers/studioEditSchemas.ts` — `ClassEditSchema`'s exact fields.
- `server/handlers/studioWriteback.ts` — the `case 'class'` dispatch and
  `StudioEditRefusal`'s `kind` union (confirms `class` refusals surface
  through the same `refusals` channel as `detach`/`swap`/`css`).
- `src/admin/pages/site/panels/classAssignmentUnsavedNotice.ts` — read in
  full; its own doc comment already states the "no writable source location
  at all" scoping, which I echoed rather than re-derived.

**Anchors.** Added two new links (`#css-write-back-ws-63-panel-02`,
`#classname-write-back-track-b2-setjsxclassname`) — hand-verified against
GitHub's actual slug algorithm (lowercase, strip backticks/punctuation, keep
letters/digits/spaces/hyphens, spaces→hyphens) rather than assumed. Also ran
a Node script that extracts every `##`-`######` header in the file, slugs it
the same way, and checks every `](#...)` link resolves — my two new anchors
resolve cleanly. The script flagged three **pre-existing** anchors
(`#tier-b--hook--context-provider`, `#one-return-renders--the-parser-selects-a-branch-parser-06`,
`#bounded-loop-expansion--not-tier-d`) as "missing" — these are false
positives of my quick heuristic script (it doesn't replicate GitHub's
em-dash/arrow handling exactly), not real breaks: the same anchor text is
used consistently from *inside* this file AND from `docs/reference/canonical-jsx.md`
in a different file, which would be a strange coincidence if it were simply
broken. I did not touch these — they predate this change and are outside the
two files I own.

**The dead `#css-is-one-way` anchor I replaced never resolved to anything**
— there is no header literally titled "CSS is one-way" in this file (the
real section is `### CSS write-back (WS-6.3, panel-02)`) — so the old TL;DR
bullet's own link target was already broken before I touched it, independent
of the false claim in its text.

## The `@layer`/Tailwind-v4-import angle (Track B3, `standing-09`) — checked, not applicable here

Read `handoff-b3-tailwind.md` in full. `unwrapCssLayers.ts` and the new
`layer-order-flattened` warning live entirely inside `cssToStyleRules` (the
CSS-*import*-into-`StyleRule` engine), which both the Site Import wizard
(`docs/features/site-import.md` — already updated by the B3 agent) and
Studio's own project-CSS load (`studioCss.ts`) call into. I grepped
`docs/features/studio-import.md` for `@layer`, `dropped-at-rule`,
`ImportWarningKind`, and any CSS-import-warning-kind table, and confirmed
this document **does not document `cssToStyleRules`'s warning-kind
vocabulary at all** — no `dropped-at-rule`, no warning table of any kind for
CSS import. That granularity lives exclusively in `site-import.md`, which
is already current. So there was nothing stale to fix here on this axis —
noting the check ran and came back clean, per the "say so" instruction,
rather than silently skipping it.

## Things I found stale/adjacent but did NOT touch (out of ownership or out of scope)

1. **`STUDIO-FIGMA-PARITY-PLAN.md`** (repo root, not under `docs/`) still
   frames B2 as pending work in its Band-2 planning table (`§5`, "B2 —
   `setJsxClassName` (M) — unblocks class assignment and Tailwind"). This is
   a roadmap/work-order document, not `docs/**`, and per my ownership grant
   I did not edit it. Whoever owns plan-status bookkeeping should mark B2
   done there.
2. **`docs/audits/2026-08-06/10-classes-vs-inline-styles.md`** — a dated,
   explicitly "Read-only audit" snapshot — has a capability-matrix row (row
   15, "`className` attribute itself") and a "Proposed fix" section that
   both describe B2 as *not yet built*. I judged this out of scope: it is a
   point-in-time audit artifact (dated, under `docs/audits/`, not one of the
   living doc destinations in the routing table), not a living reference
   that's supposed to track current code state — rewriting it would erase
   the historical record of what was actually proposed and why, which is
   the opposite of what an audit is for. Flagging it here rather than
   silently leaving it, per the instructions — if `docs/audits/` is meant to
   be kept current rather than archival, someone should say so and I (or
   the next scribe) can revisit.
3. **`docs/reference/css-class-registry.md`** — has multiple `kind: 'class'`
   references, but these are `StyleRule.kind` (the `class`-vs-`ambient`
   selector-origin discriminator), an unrelated, pre-existing enum that only
   coincidentally shares the string `'class'` with the new
   `StudioEditSchema` edit kind. Confirmed by reading the surrounding text —
   not a drift, left alone.
4. **`docs/features/studio-import.md` is 923 lines**, already well over the
   CONVENTIONS.md "~600 lines means split it" guideline *before* my edit
   (was ~890; I added ~30 for the new subsection, which was the right doc
   location for this fact — CSS write-back and `className` write-back are
   two halves of one "how does styling reach disk" story and belong next to
   each other, not split across files). I did not attempt a split — that is
   a much larger restructuring than this task's scope ("two small, precise
   follow-ups"), would touch content well beyond what I read/verified this
   session, and risks colliding with the concurrent B1 agent who is also
   actively editing this exact file's CSS sections (confirmed via
   `git status` — `docs/features/studio-import.md` was already dirty when I
   started, from other in-flight work this same session; my diff is scoped
   to exactly the two edits described above, verified with `git diff`).
   Flagging the size for whoever next does a documentation pass.

## Nothing left silently gapped

Both requested corrections are made and anchored to real, read files
(`setJsxClassName.ts`, `studioEditSchemas.ts`, `studioWriteback.ts`,
`classAssignmentUnsavedNotice.ts`). I did not find any other doc under
`docs/` referencing the old "separate feature" framing or the "nothing is
ever written back" claim (grepped repo-wide for both phrases — only matches
were in this file, before my edit, and in other agents' scratch/handoff
files which are not living docs).

## Verification run

- `./node_modules/.bin/eslint server/ai/mcp/tools/studio/editTools.ts` — clean.
- `bun test server/ai/mcp/tools/studio/editTools.test.ts` — 11 pass, 0 fail.
- `bun test server/ai/mcp/tools/studio` (full folder, broader than asked,
  to catch any collateral break) — 141 pass, 3 fail, 3 errors — all in
  `liveReloadPush.test.ts`/`qualityCheck.test.ts`, and one unrelated
  `Cannot find module './colorMath'` error from `projectTokenIndex.ts`
  (framework/tokenExtract territory, explicitly off-limits, mid-edit by a
  concurrent sibling this session). None touch `editTools.ts`,
  `StudioEditSchema`, or `class`/`className`. Matches the pattern the B2
  handoff already reported as pre-existing/unrelated.
- Did NOT run `bun run lint` / `bun run build` / `npx tsc`, per instructions.
- `git status -sb` + `git diff --stat` confirm my diff touches exactly
  `server/ai/mcp/tools/studio/editTools.ts` (4 lines: +2/-2) and
  `docs/features/studio-import.md` (34 lines: +33/-5) — nothing else.
- Did not `git add` / commit / push.

## Files touched

- `C:\Users\Admin\Documents\GitHub\Figma Killer 2\server\ai\mcp\tools\studio\editTools.ts`
- `C:\Users\Admin\Documents\GitHub\Figma Killer 2\docs\features\studio-import.md`
