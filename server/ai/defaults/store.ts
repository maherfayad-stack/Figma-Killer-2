/**
 * Studio's AI default — CRUD over `ai_defaults`.
 *
 * Studio has exactly one agent (WS-12 §8.1 D3), so there is exactly one
 * default row, keyed by the vestigial `LEGACY_SCOPE_COLUMN` constant (its
 * column keeps a permitted CHECK value; nothing branches on it). It points
 * at a specific `credential_id` (FK with `on delete restrict` — deleting the
 * default credential is rejected at the DB layer; the UI nudges to reassign
 * first).
 *
 * The default is site-wide (not per-user). Setting requires the
 * `ai.providers.manage` capability; reading requires `ai.use`.
 */

import type { DbClient } from '../../db/client'
import { isoDateOrNull } from '@core/utils/isoDate'
import { LEGACY_SCOPE_COLUMN } from '../legacyScope'

// ---------------------------------------------------------------------------
// Records + views
// ---------------------------------------------------------------------------

export interface DefaultRecord {
  readonly credentialId: string
  readonly modelId: string
  readonly updatedAt: string
  readonly updatedBy: string | null
}

interface DefaultRow {
  credential_id: string
  model_id: string
  updated_at: Date | string
  updated_by: string | null
}

function rowToRecord(row: DefaultRow): DefaultRecord {
  return {
    credentialId: row.credential_id,
    modelId: row.model_id,
    updatedAt: isoDateOrNull(row.updated_at)!,
    updatedBy: row.updated_by,
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function getDefault(db: DbClient): Promise<DefaultRecord | null> {
  const { rows } = await db<DefaultRow>`
    select credential_id, model_id, updated_at, updated_by
    from ai_defaults
    where scope = ${LEGACY_SCOPE_COLUMN}
    limit 1
  `
  return rows[0] ? rowToRecord(rows[0]) : null
}

// ---------------------------------------------------------------------------
// Write — upsert
// ---------------------------------------------------------------------------

export async function setDefault(
  db: DbClient,
  credentialId: string,
  modelId: string,
  updatedByUserId: string | null,
): Promise<DefaultRecord> {
  const { rows } = await db<DefaultRow>`
    insert into ai_defaults (scope, credential_id, model_id, updated_by)
    values (${LEGACY_SCOPE_COLUMN}, ${credentialId}, ${modelId}, ${updatedByUserId})
    on conflict (scope) do update
      set credential_id = excluded.credential_id,
          model_id = excluded.model_id,
          updated_by = excluded.updated_by,
          updated_at = current_timestamp
    returning credential_id, model_id, updated_at, updated_by
  `
  return rowToRecord(rows[0]!)
}

export async function clearDefault(db: DbClient): Promise<void> {
  await db`
    delete from ai_defaults
    where scope = ${LEGACY_SCOPE_COLUMN}
  `
}
