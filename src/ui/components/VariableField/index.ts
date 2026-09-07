/**
 * Public barrel for the "Apply variable" affordance — Figma's hover-revealed
 * variable button, the bound-variable chip, and the searchable picker.
 *
 * Field primitives (`ScrubInput`, `TokenAwareInput`, `TokenizedColorField`)
 * call `useVariableAffordance`; the site editor supplies the catalog through
 * `VariableSourceContext`.
 */
export { useVariableAffordance } from './useVariableAffordance'
export type { UseVariableAffordanceOptions, VariableAffordance } from './useVariableAffordance'
export { VariableSourceContext, useVariableOptions, useVariableCatalog } from './VariableSourceContext'
export {
  classifyVariableValue,
  filterVariablesByKind,
  COLOR_VARIABLE_KINDS,
  LENGTH_VARIABLE_KINDS,
  VARIABLE_SOURCE_LABEL,
} from './variableKind'
export type { VariableKind, VariableOption, VariableSource } from './variableKind'
export { formatVarBinding, parseVarBinding, variableChipLabel } from './varBinding'
export type { VarBinding } from './varBinding'
