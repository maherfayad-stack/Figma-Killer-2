/**
 * packages/ast-engine — pure library, zero IO. Real API lands in Phase 3
 * (playbook §4/P3): `applyOp(sourceText, op): {newText, uidRemap}` built on
 * ts-morph + prettier (never the AST default printer — see pitfalls).
 *
 * P0 only scaffolds the package boundary + the golden-file test harness
 * (`golden/` fixtures dir + `src/golden-runner.test.ts`) that P3 will fill
 * with a minimum 60 cases. This keeps the harness contract frozen early so
 * the P3 agent writes fixtures against a stable runner, not the other way
 * around.
 */
export const AST_ENGINE_PACKAGE_PHASE = 'P3' as const;

export function notImplementedYet(feature: string): never {
  throw new Error(`@ccs/ast-engine: "${feature}" is P3 scope, not implemented in P0`);
}

export { applyOp, ApplyOpError } from './apply-op.js';
export type { ApplyOpResult, ApplyOpErrorCode } from './apply-op.js';
export { invertOp, applyInverseOp } from './invert-op.js';
export type { InverseOp } from './invert-op.js';
export { EMBEDDED_PRETTIER_CONFIG } from './prettier-config.js';
export { classGroupKey, mergeClassNames } from './tailwind-groups.js';
export { buildTree } from './build-tree.js';
