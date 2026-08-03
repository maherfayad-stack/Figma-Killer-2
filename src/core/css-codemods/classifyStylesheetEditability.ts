/**
 * classifyStylesheetEditability — the tiering decision from `meta-03`
 * decision 3, applied to one CSS FILE PATH: does `setDeclaration` have an
 * honest, hand-editable source to write to for this stylesheet?
 *
 *   - `'plain-css'`  — a real, hand-authored `.css` file. `setDeclaration`
 *                      is the right tool.
 *   - `'compiled'`   — a build output with no meaningful source at this
 *                      layer (`dist/style.css`, any `.min.css`).
 *
 * ## `.module.css` is NOT compiled — it is the most hand-authored file there is
 *
 * This classifier used to answer `'compiled'` for every `*.module.css`, on the
 * reasoning that "the class name on the canvas is the hash, not what is in the
 * file." The observation is true; the conclusion was a modelling error. What is
 * compiled is the class NAME the canvas observes, not the FILE — and the fix
 * for a name is to map it, not to declare its source unwritable.
 *
 * That mapping now exists: `styleCompile.ts` already computes
 * `moduleClassMaps` (`{ file: { local: generated } }`) to do the renaming, and
 * `studioCss.ts`'s `cssModuleSource` inverts it, so a rule arriving here
 * carries the selector as WRITTEN in the module file. Every caller reaches this
 * function through a `StyleRuleSource` produced by that path, so by the time a
 * `.module.css` gets here the pre-hash-name hazard cannot occur.
 *
 * The cost of the old answer was not theoretical: `studio_create_page`
 * scaffolds a `.module.css` beside every page it creates, and this branch made
 * that file unwritable by the same agent that had just been told to style the
 * page — while the CSS Classes panel reported "Style not saved to source" for
 * any edit to one.
 *
 * The plan's third tier — **Tailwind: "edit the element's utility classes
 * instead of a CSS declaration"** — deliberately has NO representation
 * here, on purpose, not as an oversight: a Tailwind utility class (e.g.
 * `bg-red-500`) has no hand-authored FILE this classifier could point at —
 * Tailwind's engine generates the rule from the class name itself, there is
 * no `.card { background: ... }` block anywhere in the user's source to
 * open a CST on. Recognizing "this class is a Tailwind utility, redirect to
 * an element `className` edit instead" is therefore a decision the CALLER
 * makes BEFORE ever reaching a file path (by checking the class name
 * against the project's known Tailwind vocabulary, same posture as
 * `tokenExtractTailwind.ts`'s theme scan) — it is not, and cannot be, a
 * file-classification question. Wiring that caller-side check is an honest
 * gap left for the future work that also wires `StyleRule.id → (file,
 * selector, position)` (see this module's sibling `setDeclaration.ts`'s doc
 * comment and `panel-01`'s STATE.md handoff).
 *
 * Pure path-classification — no filesystem read, no dependency on the
 * project's actual toolchain config. A project that renames its build
 * output directory defeats the `dist/`/`build/` heuristic; that's an
 * accepted, documented limitation of a Tier-0-safe, no-execution classifier
 * (same posture as every other heuristic in `siteImport`/`projectProbe`).
 */

export type StylesheetEditability =
  | { kind: 'plain-css' }
  | { kind: 'compiled'; reason: string }

const COMPILED_DIR_SEGMENTS = ['/dist/', '/build/', '/.next/', '/out/', '/node_modules/']

function normalizePath(filePath: string): string {
  return `/${filePath.replace(/\\/g, '/').replace(/^\/+/, '')}`
}

/** Classify a stylesheet file path. */
export function classifyStylesheetEditability(filePath: string): StylesheetEditability {
  const normalized = normalizePath(filePath).toLowerCase()

  if (normalized.endsWith('.min.css')) {
    return { kind: 'compiled', reason: 'This is a minified build artefact, not hand-authored source.' }
  }

  if (COMPILED_DIR_SEGMENTS.some((segment) => normalized.includes(segment))) {
    return { kind: 'compiled', reason: "This file lives in a build/output directory, not the project's own source." }
  }

  return { kind: 'plain-css' }
}
