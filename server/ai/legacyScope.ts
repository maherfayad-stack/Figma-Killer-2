/**
 * Vestigial. Migration 007 pinned `scope` with an inline CHECK, and SQLite
 * cannot alter one. Studio now has exactly one agent, so this column
 * discriminates nothing — it holds a permitted constant so the constraint is
 * satisfied. Nothing reads it. Drop it when the row set is next rebuilt.
 *
 * The single home for the literal — `ai_defaults.scope` and
 * `ai_conversations.scope` are the only two columns still constrained by it
 * (`server/ai/defaults/store.ts`, `server/ai/conversations/store.ts`).
 */
export const LEGACY_SCOPE_COLUMN = 'site'
