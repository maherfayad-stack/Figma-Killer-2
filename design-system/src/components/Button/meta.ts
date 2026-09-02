/**
 * Component metadata for the studio's ComponentsPanel (playbook §4/P4,
 * modeled on Penpot's `sidebar/assets.cljs`).
 *
 * CHANGE-REQUEST: the real Almosafer DS has NO equivalent of this file —
 * its ~40 components are plain `Name.jsx` + `Name.css` pairs with zero
 * metadata/prop-schema declaration. This `meta.ts` is a fresh P0 addition
 * layered on top of the mirrored component shape, not something mirrored
 * from the real DS. When the real DS is wired in as the live
 * `design-system/` (ADR-0006), P4 will need to either hand-author a
 * `meta.ts` per real component or infer `{name, description, category}`
 * some other way (JSDoc comments, a lookup table) — `propsSchemaFrom:
 * 'types'` also assumes a typed (.tsx) component; the real DS components
 * are untyped `.jsx`, so P4's ts-morph prop-schema extraction (§4/P4) will
 * need a JS-props fallback path for them.
 */
export interface ComponentMeta {
  name: string;
  description: string;
  category: string;
  propsSchemaFrom: 'types';
}

export const meta: ComponentMeta = {
  name: 'Button',
  description: 'Primary call-to-action control. Text is set via the `label` prop, not children.',
  category: 'actions',
  propsSchemaFrom: 'types',
};
