/**
 * Golden-file test harness for `applyOp` (playbook §4/P3, §5 Global Risk #3:
 * "golden tests gate every ast-engine change").
 *
 * Fixture format (one directory per case under `golden/<case-name>/`):
 *   input.tsx     — source before the op
 *   op.json        — a single `CanvasOp` (validated against @ccs/protocol)
 *   expected.tsx  — source after applyOp + prettier, byte-exact
 *
 * P3 must export `applyOp(sourceText: string, op: CanvasOp): { newText: string; uidRemap: Record<string, string> }`
 * from `../src/apply-op.ts`. This harness is written now (P0) so the P3
 * agent fills fixtures against a frozen contract instead of inventing one
 * per-case. It stays a real, executing test: with zero fixtures (current
 * P0 state) it asserts the golden directory is readable and empty; once P3
 * adds fixtures + `apply-op.ts`, every case is run automatically — no
 * runner changes needed.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CanvasOpSchema } from '@ccs/protocol';

const __dirname = dirname(fileURLToPath(import.meta.url));
const goldenDir = join(__dirname, '..', 'golden');

function listCases(): string[] {
  return readdirSync(goldenDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const cases = listCases();

describe('ast-engine golden fixtures', () => {
  it('golden/ directory exists and is readable', () => {
    expect(existsSync(goldenDir)).toBe(true);
    expect(Array.isArray(cases)).toBe(true);
  });

  if (cases.length === 0) {
    it('has no fixtures yet — P3 fills these (playbook §4/P3, minimum 60 cases)', () => {
      expect(cases).toHaveLength(0);
    });
  }

  for (const caseName of cases) {
    it(`case: ${caseName}`, async () => {
      const caseDir = join(goldenDir, caseName);
      const inputPath = join(caseDir, 'input.tsx');
      const opPath = join(caseDir, 'op.json');
      const expectedPath = join(caseDir, 'expected.tsx');

      expect(existsSync(inputPath), `${caseName}/input.tsx missing`).toBe(true);
      expect(existsSync(opPath), `${caseName}/op.json missing`).toBe(true);
      expect(existsSync(expectedPath), `${caseName}/expected.tsx missing`).toBe(true);

      const input = readFileSync(inputPath, 'utf8');
      const rawOp = JSON.parse(readFileSync(opPath, 'utf8'));
      const op = CanvasOpSchema.parse(rawOp);
      const expected = readFileSync(expectedPath, 'utf8');

      // Dynamic import: `apply-op.ts` doesn't exist until P3. Fixtures added
      // before that module lands should fail loudly (not be silently
      // skipped), which is why this isn't wrapped in a try/catch.
      const { applyOp } = await import('./apply-op.js');
      const result = applyOp(input, op);
      expect(result.newText).toBe(expected);
    });
  }
});
