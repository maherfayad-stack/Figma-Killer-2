/**
 * variablesModel - the Variables panel's rows, derived from the token catalog.
 *
 * Pure: the catalog and the usage counts in, groups of rows out. A COLUMN is
 * a mode (the implicit default, then every mode an axis found); a CELL is the
 * declaration that paints for that token under that mode, or `null` when the
 * token has no value of its own there (it inherits the default).
 */
import {
  gateKey,
  type CatalogToken,
  type ModeGate,
  type TokenCatalog,
  type TokenCollection,
  type TokenDecl,
  type TokenUsage,
} from '@core/studio-tokens'

export interface VariableColumn {
  /** `gateKey` of the mode's gate; `base` for the default. */
  readonly id: string
  readonly label: string
  readonly gate: ModeGate
}

export interface VariableCell {
  readonly column: VariableColumn
  /** The declaration that paints under this mode, or `null` when the token has none there. */
  readonly decl: TokenDecl | null
}

export interface VariableRow {
  readonly token: CatalogToken
  readonly cells: readonly VariableCell[]
  /** Declarations under conditions that are not a mode (a width `@media`): shown as a count, not a column. */
  readonly otherDeclarations: number
  /** Every declaration is a project file Studio edits in place. */
  readonly editable: boolean
  readonly usage: TokenUsage | null
}

export interface VariableGroup {
  readonly collection: TokenCollection
  readonly rows: readonly VariableRow[]
}

const DEFAULT_COLUMN: VariableColumn = { id: 'base', label: 'Default', gate: { kind: 'base' } }

/** The default mode, then each mode the catalog's axes found, axis by axis. */
export function buildColumns(catalog: TokenCatalog): VariableColumn[] {
  const columns: VariableColumn[] = [DEFAULT_COLUMN]
  for (const axis of catalog.axes) {
    for (const mode of axis.modes) columns.push({ id: gateKey(mode.gate), label: mode.label, gate: mode.gate })
  }
  return columns
}

function cellFor(token: CatalogToken, column: VariableColumn): VariableCell {
  const matches = token.decls.filter((decl) => gateKey(decl.gate) === column.id)
  return { column, decl: matches.find((decl) => decl.winning) ?? matches.at(-1) ?? null }
}

export function buildVariableGroups(
  catalog: TokenCatalog,
  usage: ReadonlyMap<string, TokenUsage> | null,
  columns: readonly VariableColumn[],
  query: string,
): VariableGroup[] {
  const needle = query.trim().toLowerCase()
  const columnIds = new Set(columns.map((column) => column.id))
  const rowsByCollection = new Map<string, VariableRow[]>()
  for (const token of catalog.tokens) {
    if (needle && !token.name.toLowerCase().includes(needle) && !token.decls.some((decl) => decl.value.toLowerCase().includes(needle))) continue
    const row: VariableRow = {
      token,
      cells: columns.map((column) => cellFor(token, column)),
      otherDeclarations: token.decls.filter((decl) => !columnIds.has(gateKey(decl.gate))).length,
      editable: token.decls.every((decl) => decl.origin === 'project'),
      usage: usage?.get(token.name) ?? null,
    }
    const rows = rowsByCollection.get(token.collection)
    if (rows) rows.push(row)
    else rowsByCollection.set(token.collection, [row])
  }
  return catalog.collections.flatMap((collection) => {
    const rows = rowsByCollection.get(collection.id)
    return rows ? [{ collection, rows }] : []
  })
}

/** Tokens a removed token's readers can move to: the same family, never itself. */
export function replacementCandidates(catalog: TokenCatalog, token: CatalogToken): string[] {
  return catalog.tokens.filter((other) => other.name !== token.name && other.family === token.family).map((other) => other.name)
}
