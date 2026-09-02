export interface DbResult<Row = Record<string, unknown>> {
  rows: Row[]
  rowCount: number
}

/** Which SQL dialect the backing database speaks. */
export type Dialect = 'postgres' | 'sqlite'

/**
 * Dialect-aware positional placeholder for `db.unsafe()` SQL strings.
 * Postgres uses `$1, $2, …`; SQLite uses a bare `?`. This is the canonical
 * home for the helper — repositories that splice shared column lists into
 * `db.unsafe()` (see `DATA_ROW_COLUMNS`, `USER_JOINED_COLUMNS`) build their
 * WHERE clauses through it so the same SQL string works on both dialects.
 */
export function placeholder(dialect: Dialect, index: number): string {
  return dialect === 'postgres' ? `$${index}` : '?'
}

/**
 * Thrown when `close()` is called on the handle a `transaction()` callback
 * receives. That handle *borrows* the owning client's connection for the life
 * of the callback and releases it when the callback settles — closing it would
 * tear the connection out from under an open transaction.
 */
export class TransactionHandleCloseError extends Error {
  constructor() {
    super(
      'close() was called on a transaction handle. A transaction borrows its connection ' +
        'and releases it when the callback settles — close the owning DbClient instead.',
    )
    this.name = 'TransactionHandleCloseError'
  }
}

/**
 * The shared DB client interface. Used by repositories and handlers.
 * Tagged-template callable returning DbResult, plus:
 *   - .unsafe(...) — execute raw SQL strings (e.g. stored migration blocks)
 *   - .transaction(fn) — runs a callback inside a DB transaction
 *   - .close()      — release the underlying connection / file handle
 *   - .dialect      — which SQL dialect the backing database speaks
 */
export interface DbClient {
  <Row = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>>
  unsafe<Row = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<DbResult<Row>>
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>
  /**
   * Release the resources this client owns: the SQLite database file handle
   * (including its `-wal` / `-shm` companions) or the Postgres connection pool.
   * Queries issued after `close()` throw.
   *
   * Anything that creates a client for a bounded lifetime — a test, a script,
   * a one-shot task — must close it. On Windows an open SQLite handle keeps a
   * hard lock on the file, so skipping this makes the containing directory
   * un-deletable (`EBUSY`).
   *
   * Calling this on the handle passed to a `transaction()` callback throws
   * `TransactionHandleCloseError` — that handle does not own the connection.
   */
  close(): Promise<void>
  readonly dialect: Dialect
}
