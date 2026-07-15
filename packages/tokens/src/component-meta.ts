import { z } from 'zod';

/**
 * `ComponentMeta` — the ADR-0021 hand-authored per-component schema shape:
 * `{name, description, category, props: Record<propName, {type, enum?,
 * default?, control, required?}>}`. One `<Component>.meta.ts` file per
 * `design-system/src/components/<Component>.jsx`, authored FROM that
 * component's `.figma.tsx` Code Connect mapping (enum/variant values, for
 * the 29 that have one) + its `.jsx` prop destructuring (prop names +
 * defaults) — see `parseComponentMeta` for how these are read back
 * WITHOUT executing the module, and `../../../design-system/src/
 * components/*.meta.ts` for the 39 authored files.
 */

export const PropTypeSchema = z.enum(['enum', 'string', 'boolean', 'number', 'node']);
export type PropType = z.infer<typeof PropTypeSchema>;

/** `control` is the inspector-input hint (P5 consumes this) — usually
 * matches `type` 1:1, except `'json'`, the fallback for props whose real
 * shape isn't representable by the closed `PropType` vocabulary (objects,
 * unions, generics, function handlers accepting non-trivial args — ADR-
 * 0021 "JSON control fallback for un-inferable props"). */
export const ControlKindSchema = z.enum(['enum', 'string', 'boolean', 'number', 'node', 'json']);
export type ControlKind = z.infer<typeof ControlKindSchema>;

export const PropSchemaSchema = z
  .object({
    type: PropTypeSchema,
    enum: z.array(z.string()).optional(),
    default: z.unknown().optional(),
    control: ControlKindSchema,
    required: z.boolean().optional(),
  })
  .strict();
export type PropSchema = z.infer<typeof PropSchemaSchema>;

export const ComponentMetaSchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    category: z.string().min(1),
    props: z.record(z.string(), PropSchemaSchema),
  })
  .strict();
export type ComponentMeta = z.infer<typeof ComponentMetaSchema>;
