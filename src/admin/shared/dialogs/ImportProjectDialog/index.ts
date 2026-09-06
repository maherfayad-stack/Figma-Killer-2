/**
 * Public entry for the import-a-project dialog.
 *
 * Only the lazy boundary is exported — importing `ImportProjectDialog` itself
 * from outside this folder would pull its chunk (Dialog + Tabs + FileUpload +
 * both import clients) back into the caller's eager graph, which is the whole
 * thing `LazyImportProjectDialog` exists to prevent.
 */
export { LazyImportProjectDialog } from './LazyImportProjectDialog'
