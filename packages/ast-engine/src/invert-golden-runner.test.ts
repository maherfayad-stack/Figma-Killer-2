/**
 * Undo-round-trip golden harness for `invertOp`/`applyInverseOp` (ADR-0018
 * item 9 acceptance: "Undo must return the file BYTE-IDENTICAL to before").
 *
 * Reuses every `move-node-*` fixture already gated by `golden-runner.test.ts`
 * (which only proves the FORWARD `applyOp` output) and additionally proves,
 * per case:
 *
 *   1. `invertOp(input, op)` computed against the PRE-image succeeds.
 *   2. `applyInverseOp(expected, inverse)` — applied against the POST-image
 *      (the fixture's own `expected.tsx`, i.e. exactly what the daemon's
 *      undo stack would hold) — restores `input.tsx` BYTE-IDENTICAL.
 *
 * This is scoped to `move-node-*` (rather than every golden case) so it
 * directly covers the reparenting cascade bug this file was added to guard
 * against (move-node-08, move-node-09 — a cross-parent move whose OLD
 * parent's own astPath shifts because the insertion side of the move
 * cascades through the old parent's ancestor chain; see the module doc on
 * `invertMoveNode` in `invert-op.ts`), without also having to special-case
 * every OTHER op type's legitimate invert refusals (e.g.
 * `insert-node-06-self-closing-conversion`).
 *
 * ONE move-node fixture (`move-node-05-to-self-closing-parent`) is itself a
 * legitimate one-way refusal — moving a node INTO a self-closing parent
 * converts it to a container (`<Card />` -> `<Card></Card>`), and moving the
 * child back out can't un-convert the container back to self-closing. This
 * was found BY this test (property-test/golden-suite strengthening turned up
 * a second real invertOp bug beyond the reparenting cascade): `invertMoveNode`
 * now refuses this case with `ApplyOpError('unsupported')` rather than
 * silently leaving `<Card></Card>` behind — asserted explicitly below.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CanvasOpSchema, type MoveNodeOp } from '@ccs/protocol';
import { applyInverseOp, invertOp } from './invert-op.js';
import { ApplyOpError } from './errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(__dirname, '..', 'golden');

/** Legitimate one-way-conversion refusals — invertOp is EXPECTED to throw
 * `ApplyOpError('unsupported')` for these, not to produce a (lossy) inverse. */
const EXPECTED_REFUSALS = new Set(['move-node-05-to-self-closing-parent']);

function listMoveNodeCases(): string[] {
  return readdirSync(goldenDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('move-node-'))
    .map((entry) => entry.name)
    .sort();
}

const cases = listMoveNodeCases();

describe('ast-engine invert golden fixtures (move-node undo round-trip)', () => {
  it('found move-node-* golden fixtures to exercise', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const caseName of cases) {
    const label = EXPECTED_REFUSALS.has(caseName)
      ? `invert refuses (one-way conversion): ${caseName}`
      : `undo round-trip: ${caseName}`;

    it(label, () => {
      const caseDir = join(goldenDir, caseName);
      const inputPath = join(caseDir, 'input.tsx');
      const opPath = join(caseDir, 'op.json');
      const expectedPath = join(caseDir, 'expected.tsx');

      expect(existsSync(inputPath), `${caseName}/input.tsx missing`).toBe(true);
      expect(existsSync(opPath), `${caseName}/op.json missing`).toBe(true);
      expect(existsSync(expectedPath), `${caseName}/expected.tsx missing`).toBe(true);

      const input = readFileSync(inputPath, 'utf8');
      const rawOp = JSON.parse(readFileSync(opPath, 'utf8'));
      const op = CanvasOpSchema.parse(rawOp) as MoveNodeOp;
      const expected = readFileSync(expectedPath, 'utf8');

      if (EXPECTED_REFUSALS.has(caseName)) {
        expect(() => invertOp(input, op)).toThrow(ApplyOpError);
        return;
      }

      // Inverse MUST be computed against the PRE-image (invertOp's documented
      // contract), then applied against the POST-image (applyInverseOp) —
      // mirroring exactly how the daemon's undo stack uses these two
      // functions (ADR-0018 item 9 / ADR-0019 CR 2).
      const inverse = invertOp(input, op);
      const undone = applyInverseOp(expected, inverse);

      expect(undone.newText, `${caseName}: undo did not restore input.tsx byte-identically`).toBe(input);
    });
  }
});
