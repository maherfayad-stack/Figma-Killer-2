export { PropVariantFieldsSchema } from './variantSchema'
export type {
  ElementPosition,
  PropDefault,
  PropVariantFields,
  SourceRange,
  UnionHome,
  VariantBinding,
  VariantEntry,
  VariantMember,
  VariantRule,
} from './variantSchema'
export { deriveVariantStyleContext, variantStyleTargetFor } from './variantStyleContext'
export type {
  ElementTail,
  VariantAxisInput,
  VariantStyleContext,
  VariantStyleRefusal,
  VariantStyleRefusalReason,
  VariantStyleRule,
  VariantStyleTarget,
} from './variantStyleContext'
export { MAX_GALLERY_CELLS, planVariantGrid } from './variantGrid'
export type { GalleryAxis, GalleryAxisInput, GalleryCell, GalleryPlan, GalleryValue } from './variantGrid'
export {
  GALLERY_NODE_ID_PREFIX,
  PROP_NAME_PATTERN,
  VARIANT_NAME_PATTERN,
  galleryNodeIdPrefix,
  isGalleryGridNodeId,
  isGalleryPage,
  propNameError,
  variantNameError,
} from './variantNames'
