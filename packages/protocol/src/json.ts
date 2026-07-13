import { z } from 'zod';

/**
 * Json — Appendix B's `set-prop` value type references a bare `Json` without
 * defining it. We define it here as the standard JSON-serializable value
 * (the wire-protocol contract), deliberately WIDER than what `ast-engine`
 * (P3) will actually accept for a literal prop write (string/number/boolean
 * only — see playbook §4/P3: "literals + template strings only; refuse
 * expressions"). Arrays/objects parse fine at the protocol layer so the
 * daemon can receive an op, attempt it, and answer with a structured
 * `op-rejected` DaemonEvent — rejection is a *runtime* decision made by
 * ast-engine, not a schema-parse failure. See CHANGE-REQUEST in this
 * package's README/tests.
 */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export const JsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonSchema),
    z.record(z.string(), JsonSchema),
  ]),
);
