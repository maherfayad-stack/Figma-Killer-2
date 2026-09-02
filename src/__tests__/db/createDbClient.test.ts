import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'bun:test'
import { createDbClient, isSqliteUrl, parseSqlitePath } from '../../../server/db'
import { pgMigrations } from '../../../server/db/migrations-pg'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'
import { runMigrations } from '../../../server/db/runMigrations'

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'studio-db-selection-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('createDbClient — DATABASE_URL dialect selection', () => {
  test('recognizes every SQLite URL form used by server and dev tooling', () => {
    expect(isSqliteUrl('sqlite:./.tmp/dev.db')).toBe(true)
    expect(isSqliteUrl('file:/tmp/studio.db')).toBe(true)
    expect(isSqliteUrl('/tmp/studio.db')).toBe(true)
    expect(isSqliteUrl('postgres://studio:secret@localhost:5432/studio')).toBe(false)
    expect(isSqliteUrl('postgresql://studio:secret@localhost:5432/studio')).toBe(false)

    expect(parseSqlitePath('sqlite:./.tmp/dev.db')).toBe('./.tmp/dev.db')
    expect(parseSqlitePath('file:/tmp/studio.db')).toBe('/tmp/studio.db')
    expect(parseSqlitePath('/tmp/studio.db')).toBe('/tmp/studio.db')
  })

  test('creates SQLite clients, parent directories, and SQLite migrations for SQLite URLs', async () => {
    await withTempDir(async (dir) => {
      for (const databaseUrl of [
        `sqlite:${join(dir, 'sqlite-prefix', 'cms.db')}`,
        `file:${join(dir, 'file-prefix', 'cms.db')}`,
        join(dir, 'bare-path', 'cms.db'),
      ]) {
        const { db, migrations } = createDbClient(databaseUrl)
        try {
          expect(db.dialect).toBe('sqlite')
          expect(migrations).toBe(sqliteMigrations)

          await runMigrations(db, migrations)
          await runMigrations(db, migrations)

          const { rows } = await db<{ count: number }>`select count(*) as count from schema_migrations`
          expect(rows[0]?.count).toBe(sqliteMigrations.length)
        } finally {
          // The temp dir cannot be removed while the file handle is open.
          await db.close()
        }
      }
    })
  })

  test('selects Postgres clients and Postgres migrations for supported Postgres schemes', async () => {
    for (const databaseUrl of [
      'postgres://studio:secret@127.0.0.1:65432/studio',
      'postgresql://studio:secret@127.0.0.1:65432/studio',
    ]) {
      const { db, migrations } = createDbClient(databaseUrl)
      try {
        expect(db.dialect).toBe('postgres')
        expect(migrations).toBe(pgMigrations)
      } finally {
        await db.close()
      }
    }
  })

  test('rejects unsupported DATABASE_URL schemes with an operator-facing message', () => {
    expect(() => createDbClient('mysql://studio:secret@localhost/studio'))
      .toThrow('Unsupported DATABASE_URL: mysql:. Expected sqlite:..., file:..., postgres://..., or postgresql://...')
  })
})
