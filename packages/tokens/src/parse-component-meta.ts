import { Project } from 'ts-morph';
import { evaluateExpressionToJson } from './parse-literal.js';
import { ComponentMetaSchema, type ComponentMeta } from './component-meta.js';

/**
 * Parses a `*.meta.ts` file's SOURCE TEXT and extracts its
 * `export default { ... } satisfies ComponentMeta;` literal WITHOUT ever
 * executing the module (no `import()`/`require()`/`eval` — same
 * discipline as `parseAlmosaferTokensJs`, and for the same reason: this
 * keeps meta.ts reading a pure, synchronous, side-effect-free AST walk,
 * which is what lets `listComponents()`/`getPropSchema()` in `catalog.ts`
 * be SYNCHRONOUS per the frozen ADR-0022 signatures — a `dynamic import()`
 * of a `.ts` file is inherently async and would break that contract).
 *
 * Every authored meta.ts is a plain `export default { ... };` object
 * literal (optionally wrapped in `satisfies ComponentMeta` / `as
 * ComponentMeta` — both are unwrapped by `evaluateExpressionToJson`, but
 * NOT required). Deliberately no `import type { ComponentMeta } from
 * '@ccs/tokens'` in the authored files themselves: `design-system/` is a
 * separate git repo (ADR-0008) with no dependency on this monorepo's
 * packages, no tsconfig, and an eslint scope limited to `**\/*.{js,jsx}` —
 * an unresolvable cross-repo type import would be dead weight (never
 * type-checked by anything, and red-squiggly in any editor open on that
 * repo alone). Validated structurally here via `ComponentMetaSchema`
 * instead, which gives the same "shape must be right" guarantee without
 * the coupling.
 */
export function parseComponentMeta(sourceText: string, fileNameForErrors = 'meta.ts'): ComponentMeta {
  const project = new Project({ useInMemoryFileSystem: true, skipFileDependencyResolution: true });
  const sourceFile = project.createSourceFile(fileNameForErrors, sourceText);

  const exportAssignment = sourceFile.getExportAssignments()[0];
  if (!exportAssignment) {
    throw new Error(
      `@ccs/tokens: ${fileNameForErrors} has no \`export default\` — meta.ts files must be authored as ` +
        '`export default { ... };`',
    );
  }

  const value = evaluateExpressionToJson(exportAssignment.getExpression());
  const parsed = ComponentMetaSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`@ccs/tokens: invalid ComponentMeta in ${fileNameForErrors}: ${parsed.error.message}`);
  }
  return parsed.data;
}
