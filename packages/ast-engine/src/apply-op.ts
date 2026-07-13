import type { CanvasOp } from '@ccs/protocol';

export interface ApplyOpResult {
  newText: string;
  uidRemap: Record<string, string>;
}

/**
 * applyOp — pure, zero-IO codemod entrypoint (playbook §4/P3): ts-morph
 * manipulations + prettier (never the AST default printer). Not
 * implemented in P0. This stub exists so `golden-runner.test.ts` has a real
 * module to import — fixtures added under `golden/` ahead of P3 landing the
 * real implementation fail loudly (this throw) instead of being silently
 * skipped by the harness.
 */
export function applyOp(_sourceText: string, _op: CanvasOp): ApplyOpResult {
  throw new Error('@ccs/ast-engine: applyOp is P3 scope, not implemented in P0');
}
