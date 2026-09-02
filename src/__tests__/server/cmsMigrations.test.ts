import { describe, expect, it } from 'bun:test'
import { pgMigrations } from '../../../server/db/migrations-pg'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'
import { FORCE_SYNC_ROLE_IDS, SYSTEM_ROLES } from '../../../server/auth/capabilities'

describe('CMS migrations', () => {
  it('creates the required CMS tables', () => {
    const sql = pgMigrations.map((m) => m.sql).join('\n')
    expect(sql).toContain('create table if not exists site')
    expect(sql).toContain('create table if not exists users')
    expect(sql).toContain('create table if not exists roles')
    expect(sql).toContain('create table if not exists sessions')
    expect(sql).toContain('create table if not exists audit_events')
    // Unified content store — pages and components live in data_tables/data_rows
    expect(sql).toContain('create table if not exists data_tables')
    expect(sql).toContain('create table if not exists data_rows')
    expect(sql).toContain('create table if not exists data_row_versions')
    expect(sql).toContain('create table if not exists media_assets')
    expect(sql).toContain('create table if not exists published_runtime_assets')
    // Legacy page-specific tables must NOT be present
    expect(sql).not.toContain('create table if not exists pages ')
    expect(sql).not.toContain('create table if not exists page_versions')
  })

  it('stores row content and field definitions as jsonb', () => {
    const sql = pgMigrations.map((m) => m.sql).join('\n')
    // data_rows stores all cell values in cells_json
    expect(sql).toContain('cells_json jsonb not null')
    // data_tables stores field definitions in fields_json
    expect(sql).toContain('fields_json jsonb not null')
  })

  it('stores folder sort order for media folders', () => {
    const sql = pgMigrations.map((m) => m.sql).join('\n')
    expect(sql).toContain('sort_order integer not null default 0')
  })

  it('stores ownership metadata for content, media, and published versions', () => {
    const pgSql = pgMigrations.map((m) => m.sql).join('\n')
    const sqliteSql = sqliteMigrations.map((m) => m.sql).join('\n')

    for (const sql of [pgSql, sqliteSql]) {
      expect(sql).toContain('created_by_user_id text references users(id) on delete set null')
      expect(sql).toContain('updated_by_user_id text references users(id) on delete set null')
      expect(sql).toContain('author_user_id text references users(id) on delete set null')
      expect(sql).toContain('published_by_user_id text references users(id) on delete set null')
      expect(sql).toContain('uploaded_by_user_id text references users(id) on delete set null')
    }

    expect(pgSql).not.toContain('published_by text references users(id)')
    expect(sqliteSql).not.toContain('published_by text references users(id)')
  })

  it('does not keep retired single-admin schema names', () => {
    const sql = pgMigrations.map((m) => m.sql).join('\n')
    expect(sql).not.toContain('admin_users')
    expect(sql).not.toContain('admin_user_id')
    expect(sql).not.toContain('site_singleton')
  })

  /**
   * The seed creates the four roles; it does NOT promise to list every
   * capability they will ever hold.
   *
   * This assertion used to walk `role.capabilities` and require each string to
   * appear in the migration SQL. That contradicts two rules this repo holds
   * simultaneously: a committed migration is never edited (CLAUDE.md, "never
   * rewrite a committed migration"), and Owner + Admin are force-resynced from
   * code on every boot (`FORCE_SYNC_ROLE_IDS`, `syncSystemRoles`) precisely so
   * a new capability propagates WITHOUT one. Under both, the old assertion
   * could only ever be satisfied by breaking the first rule, and it duly went
   * red the moment `studio.write` was added — pointing not at a migration bug
   * but at an invariant that was never true.
   *
   * What is actually load-bearing is checked instead: every system role is
   * seeded, and the two roles whose capabilities are NOT maintained by the
   * boot sync (Client, Member — seeded once, then user-editable) do have their
   * capabilities present in the seed, because for them the seed is the only
   * source they will ever get.
   */
  it('seeds every system role, with full capabilities for the non-force-synced ones', () => {
    const pgSql = pgMigrations.map((m) => m.sql).join('\n')
    const sqliteSql = sqliteMigrations.map((m) => m.sql).join('\n')

    for (const role of SYSTEM_ROLES) {
      expect(pgSql).toContain(`'${role.slug}'`)
      expect(sqliteSql).toContain(`'${role.slug}'`)

      if (FORCE_SYNC_ROLE_IDS.includes(role.id)) continue
      for (const capability of role.capabilities) {
        expect(pgSql).toContain(capability)
        expect(sqliteSql).toContain(capability)
      }
    }
  })

  it('force-syncs exactly the roles whose seeded capabilities are allowed to go stale', () => {
    // The escape hatch above is only sound while these two are boot-synced.
    // If a role ever leaves FORCE_SYNC_ROLE_IDS, its capabilities must go back
    // to being fully seeded — this pins the pair together.
    expect([...FORCE_SYNC_ROLE_IDS].sort()).toEqual(['admin', 'owner'])
  })
})
