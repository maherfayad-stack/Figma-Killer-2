/**
 * DataRow — the live, mutable `data_rows` record shape, split out of
 * `schemas.ts` (perf-XX) so importing it does not also pull in the
 * 14-variant `DataField` union / `DataTableSchema`. `DataRowSchema.cells` is
 * just `Type.Record(Type.String(), Type.Unknown())` — it references neither.
 *
 * This matters on the anonymous login critical path: `cmsAuth.ts` →
 * `responseSchemas.ts` needs only `DataRowSchema`, but every top-level
 * statement in a source file ships together as one lazy-init closure, so
 * before this split the whole field-type union rode along on every visit,
 * logged in or not. `DataRowStatusSchema`/`DataRowCellsSchema`/
 * `DataUserReferenceSchema` moved alongside it — all three are DataRow-only
 * dependencies. `schemas.ts` still imports `DataRowCellsSchema`/
 * `DataRowStatusSchema` back from here for the OTHER row-shaped schemas that
 * stay there (`DataRowVersionSchema`, `PublishedDataRowSchema`,
 * `DeletedRowSummarySchema`, the create/draft input schemas) — that is an
 * ordinary internal dependency, not a re-export shim.
 *
 * Schemas are the source of truth. Types are derived via `Static<typeof T>`.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'

// ---------------------------------------------------------------------------
// DataRowStatus
// ---------------------------------------------------------------------------

export const DataRowStatusSchema = Type.Union([
  Type.Literal('draft'),
  Type.Literal('published'),
  Type.Literal('unpublished'),
  // 'scheduled' rows wait for the publish scheduler tick — see
  // `server/publish/publishScheduler.ts`. The row's
  // `scheduledPublishAt` carries the target ISO datetime; the tick
  // calls `publishDataRow(...)` once `now() >= scheduledPublishAt`
  // and flips the row to 'published' (or back to 'draft' on
  // publish failure).
  Type.Literal('scheduled'),
])

export type DataRowStatus = Static<typeof DataRowStatusSchema>

// ---------------------------------------------------------------------------
// DataRowCells
// ---------------------------------------------------------------------------

export const DataRowCellsSchema = Type.Record(Type.String(), Type.Unknown())

export type DataRowCells = Static<typeof DataRowCellsSchema>

// ---------------------------------------------------------------------------
// DataUserReference (was: ContentUserReference)
// ---------------------------------------------------------------------------

export const DataUserReferenceSchema = Type.Object({
  id: Type.String(),
  email: Type.String(),
  displayName: Type.String(),
  roleSlug: Type.Union([Type.String(), Type.Null()]),
  roleName: Type.Union([Type.String(), Type.Null()]),
})

export type DataUserReference = Static<typeof DataUserReferenceSchema>

const NullableDataUserReferenceSchema = Type.Union([DataUserReferenceSchema, Type.Null()])
const NullableUserIdSchema = Type.Union([Type.String(), Type.Null()])

// ---------------------------------------------------------------------------
// DataRow — the live, mutable row state.
// ---------------------------------------------------------------------------

export const DataRowSchema = Type.Object({
  id: Type.String(),
  tableId: Type.String(),
  cells: DataRowCellsSchema,
  /** Denormalized from `cells.slug` for fast unique / route lookup. */
  slug: Type.String(),
  status: DataRowStatusSchema,
  authorUserId: NullableUserIdSchema,
  createdByUserId: NullableUserIdSchema,
  updatedByUserId: NullableUserIdSchema,
  publishedByUserId: NullableUserIdSchema,
  author: NullableDataUserReferenceSchema,
  createdBy: NullableDataUserReferenceSchema,
  updatedBy: NullableDataUserReferenceSchema,
  publishedBy: NullableDataUserReferenceSchema,
  /** ISO datetime string from DB */
  createdAt: Type.String(),
  /** ISO datetime string from DB */
  updatedAt: Type.String(),
  publishedAt: Type.Union([Type.String(), Type.Null()]),
  /**
   * Wall-clock ISO datetime at which the publish scheduler should fire
   * `publishDataRow(...)` for this row. Set whenever
   * `status === 'scheduled'`; null otherwise. Server-side tick:
   * `server/publish/publishScheduler.ts`. UI entry point: the
   * "Schedule publish…" action in the page/post toolbar.
   */
  scheduledPublishAt: Type.Union([Type.String(), Type.Null()]),
  deletedAt: Type.Union([Type.String(), Type.Null()]),
})

export type DataRow = Static<typeof DataRowSchema>
