/**
 * In-memory property test (ADR-0018 / P3 acceptance): generate >=200
 * random VALID ops against template-like sources → after each, assert:
 *   1. the result still parses as valid TSX,
 *   2. prettier is idempotent (formatting the output again is a no-op),
 *   3. invertOp + re-apply (applyInverseOp) restores the PRE-image
 *      byte-identical.
 *
 * No property-testing library (fast-check et al.) is in this monorepo's
 * catalog and adding one for a single test file isn't "truly needed" per
 * the worker brief — a small seeded PRNG is enough and keeps this a
 * zero-new-dependency test. The seed is fixed so a failure is
 * deterministic/reproducible, not flaky.
 *
 * Strategy: run several independent "chains", each starting from a
 * template source and applying a SEQUENCE of random valid ops
 * cumulatively (the output of step N becomes the input of step N+1),
 * verifying all 3 invariants after EVERY step — this stresses compounding
 * structural change the same way the daemon's 500-op acceptance does,
 * just at ast-engine's pure-library scope. A step whose randomly-picked
 * op turns out ineligible (would throw `ApplyOpError`) is retried with a
 * different random choice — this is a generator-quality concern, not a
 * correctness finding, so it doesn't fail the test.
 */
import { describe, expect, it } from 'vitest';
import { Project, SyntaxKind } from 'ts-morph';
import type { CanvasOp, NodeUid } from '@ccs/protocol';
import { applyOp } from './apply-op.js';
import { invertOp, applyInverseOp } from './invert-op.js';
import { ApplyOpError } from './errors.js';
import { formatWithEmbeddedConfig } from './prettier-config.js';
import { deriveUidPathsForFile, type DerivedUidPathEntry } from './uid-path.js';
import { isDynamicJsxNode } from './dynamic.js';

// ---- seeded PRNG (mulberry32) --------------------------------------------

function mulberry32(seed: number) {
  let a = seed;
  return function random(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

function pickInt(rng: () => number, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

// ---- templates ------------------------------------------------------------

const TEMPLATES: readonly string[] = [
  `export function FrameA() {\n  return (\n    <div className="container flex">\n      <span className="label">a</span>\n      <p>b</p>\n      <em>c</em>\n    </div>\n  );\n}\n`,
  `import { cn } from './utils';\nexport function FrameB(props: { active?: boolean }) {\n  return (\n    <section className={cn('panel p-4', props.active && 'panel--active')}>\n      <Card />\n      <p className="text-sm">note</p>\n    </section>\n  );\n}\n`,
  `export function FrameC() {\n  return (\n    <>\n      <span>x</span>\n      <p>y</p>\n    </>\n  );\n}\n`,
  `export function FrameD({ items }: { items: string[] }) {\n  return (\n    <div>\n      <header>header</header>\n      {items.map((i) => (\n        <span key={i}>{i}</span>\n      ))}\n      <footer>footer</footer>\n    </div>\n  );\n}\n`,
];

const TEXT_SAMPLES = [
  'hello world',
  'Updated label',
  'مرحبا بالعالم',
  'a {b} c',
  'Great job 🎉',
  '',
  'line one\nline two',
];

const TAGS = ['div', 'span', 'p', 'em', 'section'];
const CLASS_SAMPLES = ['flex', 'p-4', 'bg-red-500', 'text-lg', 'gap-2', 'rounded-lg', 'hover:bg-blue-500'];

// ---- generator ------------------------------------------------------------

type OpKind = 'set-text' | 'set-prop' | 'set-classes' | 'insert-node' | 'delete-node' | 'move-node' | 'wrap-node';
const OP_KINDS: readonly OpKind[] = [
  'set-text',
  'set-prop',
  'set-classes',
  'insert-node',
  'delete-node',
  'move-node',
  'wrap-node',
];

function staticEntries(sourceFile: ReturnType<Project['createSourceFile']>): DerivedUidPathEntry[] {
  return deriveUidPathsForFile(sourceFile).filter((e) => !isDynamicJsxNode(e.node));
}

function uidOf(relPath: string, astPath: string): NodeUid {
  return `${relPath}:${astPath}` as NodeUid;
}

const REL = 'src/Frame.tsx';

function generateOp(rng: () => number, sourceText: string): CanvasOp | null {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('f.tsx', sourceText);
  const entries = staticEntries(sourceFile);
  if (entries.length === 0) return null;

  const kind = pick(rng, OP_KINDS);

  switch (kind) {
    case 'set-text': {
      const nonSelfClosing = entries.filter((e) => e.node.getKind() !== SyntaxKind.JsxSelfClosingElement);
      if (nonSelfClosing.length === 0) return null;
      const target = pick(rng, nonSelfClosing);
      return { t: 'set-text', uid: uidOf(REL, target.astPath), text: pick(rng, TEXT_SAMPLES) };
    }
    case 'set-prop': {
      const elementLike = entries.filter((e) => e.type === 'JSXElement');
      if (elementLike.length === 0) return null;
      const target = pick(rng, elementLike);
      const propChoice = pickInt(rng, 3);
      const value = propChoice === 0 ? pick(rng, ['a', 'b', 'test-value']) : propChoice === 1 ? pickInt(rng, 10) : true;
      return { t: 'set-prop', uid: uidOf(REL, target.astPath), name: 'data-test', value };
    }
    case 'set-classes': {
      const elementLike = entries.filter((e) => e.type === 'JSXElement');
      if (elementLike.length === 0) return null;
      const target = pick(rng, elementLike);
      return {
        t: 'set-classes',
        uid: uidOf(REL, target.astPath),
        add: [pick(rng, CLASS_SAMPLES)],
        remove: [],
      };
    }
    case 'insert-node': {
      const target = pick(rng, entries);
      const useDs = rng() < 0.3;
      return {
        t: 'insert-node',
        parentUid: uidOf(REL, target.astPath),
        index: pickInt(rng, 3),
        source: useDs ? { kind: 'ds-component', name: 'Button' } : { kind: 'element', tag: pick(rng, TAGS) },
      };
    }
    case 'delete-node': {
      const nonRoot = entries.filter((e) => e.astPath.includes('.'));
      if (nonRoot.length === 0) return null;
      const target = pick(rng, nonRoot);
      return { t: 'delete-node', uid: uidOf(REL, target.astPath) };
    }
    case 'move-node': {
      const nonRoot = entries.filter((e) => e.astPath.includes('.'));
      if (nonRoot.length === 0) return null;
      const target = pick(rng, nonRoot);
      // Deliberately NOT restricted to same-parent reorders: `candidates`
      // includes any other node in the file (minus target's own subtree),
      // so this generator freely produces CROSS-parent reparenting moves —
      // including ones that reparent a deeply-nested node out to an
      // ancestor, which is exactly the shape that can cascade-shift the old
      // parent's own astPath (see invertMoveNode's module doc in
      // invert-op.ts, and golden fixtures move-node-08/09). Restricting this
      // to same-parent moves would dodge that bug class rather than prove
      // it's fixed — do not narrow this filter.
      const candidates = entries.filter(
        (e) => e.node !== target.node && !e.astPath.startsWith(`${target.astPath}.`),
      );
      if (candidates.length === 0) return null;
      const newParent = pick(rng, candidates);
      return {
        t: 'move-node',
        uid: uidOf(REL, target.astPath),
        newParentUid: uidOf(REL, newParent.astPath),
        index: pickInt(rng, 3),
      };
    }
    case 'wrap-node': {
      const nonRoot = entries.filter((e) => e.astPath.includes('.'));
      if (nonRoot.length === 0) return null;
      const target = pick(rng, nonRoot);
      return {
        t: 'wrap-node',
        uids: [uidOf(REL, target.astPath)],
        wrapper: { tag: 'div', classes: pick(rng, CLASS_SAMPLES) },
      };
    }
  }
}

// ---- the property test -----------------------------------------------------

const CHAINS = 6;
const STEPS_PER_CHAIN = 40; // 6 * 40 = 240 >= 200 required
const MAX_ATTEMPTS_PER_STEP = 25;

describe('property test: N random valid ops preserve all 3 invariants', () => {
  let totalSteps = 0;
  let totalAttempts = 0;

  it(`runs ${CHAINS} chains of ${STEPS_PER_CHAIN} steps (>= 200 total ops)`, () => {
    const rng = mulberry32(0xc0ffee);

    for (let chain = 0; chain < CHAINS; chain++) {
      let currentSource = TEMPLATES[chain % TEMPLATES.length]!;

      for (let step = 0; step < STEPS_PER_CHAIN; step++) {
        let applied = false;

        for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_STEP && !applied; attempt++) {
          totalAttempts++;
          const op = generateOp(rng, currentSource);
          if (!op) continue;

          let inverse;
          let result;
          try {
            inverse = invertOp(currentSource, op);
            result = applyOp(currentSource, op);
          } catch (err) {
            // Legitimate, expected refusals ONLY: invertOp declining to
            // invert (e.g. dynamic set-text, spread prop) or applyOp
            // declining the forward op (e.g. dynamic-locked target) are
            // generator-quality noise, not correctness findings — retry a
            // different random pick. This is the ONLY try/catch in this
            // loop that's allowed to swallow ApplyOpError: once invertOp has
            // returned a value, it is asserting that inverse IS well-formed
            // and applicable, so any ApplyOpError from applying it below
            // (see Invariant 3) is a real bug and must NOT be caught here —
            // see uid-not-found reparenting-cascade bug this test caught in
            // invertMoveNode (fixed in invert-op.ts; move-node-08/09 golden
            // fixtures + invert-golden-runner.test.ts pin the fix).
            if (err instanceof ApplyOpError) continue; // ineligible pick, retry
            throw err;
          }

          // Invariant 1: result still parses as valid TSX — SYNTACTIC
          // diagnostics only (not semantic/type diagnostics: this in-memory
          // fixture has no real React/design-system/'./utils' type
          // declarations, so semantic checks would false-positive on
          // "cannot find module" for perfectly valid output).
          const project = new Project({ useInMemoryFileSystem: true });
          const parsed = project.createSourceFile('check.tsx', result.newText);
          const diagnostics = project.getProgram().getSyntacticDiagnostics(parsed);
          expect(diagnostics, `chain ${chain} step ${step}: syntax errors in output`).toHaveLength(0);

          // Invariant 2: prettier is idempotent.
          const reformatted = formatWithEmbeddedConfig(result.newText);
          expect(reformatted, `chain ${chain} step ${step}: prettier not idempotent`).toBe(result.newText);

          // Invariant 3: invertOp + applyInverseOp restores byte-identical.
          // Deliberately NOT wrapped in a try/catch that swallows
          // ApplyOpError: invertOp already had its chance to refuse (above)
          // if this op genuinely can't be inverted. If it returned an
          // InverseOp, applying that inverse against the post-image MUST
          // succeed and MUST restore byte-identical — an ApplyOpError or a
          // mismatch here is a real invertOp/applyInverseOp correctness bug,
          // not an ineligible generator pick, and must fail the test loudly
          // rather than being retried away.
          const restoredText = applyInverseOp(result.newText, inverse).newText;
          expect(restoredText, `chain ${chain} step ${step}: invert round-trip not byte-identical`).toBe(
            currentSource,
          );

          currentSource = result.newText;
          applied = true;
          totalSteps++;
        }
      }
    }

    expect(totalSteps, 'total successfully-verified ops across all chains').toBeGreaterThanOrEqual(200);
    console.log(`property test: ${totalSteps} verified ops (${totalAttempts} attempts across ${CHAINS} chains)`);
  }, 60_000);
});
