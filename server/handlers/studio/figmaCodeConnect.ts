/**
 * figmaCodeConnect — reads a package's own Figma Code Connect mapping files
 * (`*.figma.tsx`, https://www.figma.com/code-connect) straight off disk,
 * syntactically, never executing them.
 *
 * ## Why this exists
 *
 * `packageManifest.ts`'s `.d.ts`/`.tsx`-source extraction returns ZERO
 * components for `@alm-design/design-system`: the package publishes a bundled
 * `dist/index.js` plus untyped `.jsx` component sources — no `.d.ts`, no typed
 * entry, so there is nothing `classifyPropType` can read a prop shape out of
 * (`package-manifest-static-empty`, confirmed against the real install).
 *
 * The SAME package ships 29 `*.figma.tsx` Code Connect files under
 * `src/components/` — each one a static `figma.connect(Component, url, {
 * props: {...}, example: (...) => <JSX/> })` call carrying exactly the
 * component API `packageManifest.ts` could not extract (every prop name, its
 * kind, every enum's real code-side values) PLUS a Figma binding (a node URL)
 * `packageManifest.ts` has no way to know about at all. One parse serves both
 * the design-system-awareness workstream (`studio_list_components`) and a
 * future "pull this component's assets from Figma" workstream.
 *
 * ## Posture — identical to `packageManifest.ts`
 *
 * Fully syntactic, ts-morph AST only, same "parse, never execute" invariant
 * that module's own header documents at length (not repeated here).
 * `@figma/code-connect` — the package these files import `figma` from — is
 * NOT a dependency of Studio and MUST NOT become one: this module never
 * imports it, never resolves what `figma.connect`/`figma.enum`/
 * `figma.string`/`figma.boolean` actually DO at runtime. Each is read purely
 * as a call-expression SHAPE (callee name + argument syntax) — the exact
 * same posture `packageManifest.ts` documents for reading a written type
 * annotation's text instead of asking the checker to resolve it.
 *
 * ## Robustness — real Code Connect files are hand-authored and vary
 *
 * Measured against the real 29-file corpus, not assumed:
 *   - some ship a `REPLACE-ME` placeholder node-id, never filled in (the
 *     literal `figma connect create` scaffold template — 5 of 29 files);
 *   - some map a Figma enum value to a `boolean`/`number` rather than a
 *     `string` (`figma.enum('Switch', { on: true, off: false })`);
 *   - some have a literal empty `props: {}` (no variant worth mapping — a
 *     single-shape component; 3 of 29 files);
 *   - the imported local component name doesn't always match the file's own
 *     basename (`ListItem.figma.tsx` imports `{ ListItem } from './List'`);
 *   - a mapping entry can carry a same-line trailing "(approx)" caveat
 *     comment ts-morph's own `getTrailingCommentRanges()` does not reliably
 *     attach to the entry — see `inlineMappingNotes` below for why this
 *     reads already-isolated source TEXT instead, and only for that one
 *     narrow purpose (never a second parser for the file as a whole).
 *
 * Every extraction step below degrades to `undefined`/an empty field rather
 * than throwing, a single unparseable `.figma.tsx` file is skipped (with a
 * warning) rather than failing the whole batch, and a package that ships no
 * `*.figma.tsx` files at all is the ORDINARY case (most packages), not an
 * error — see `collectFigmaCodeConnectComponents`.
 */
import { join } from 'node:path'
import { Node, Project, SyntaxKind, type ObjectLiteralExpression, type SourceFile } from 'ts-morph'
import { listWorkspaceFiles } from '@core/page-parser'
import type { ProbeWarning } from './projectProfileSchema'
import type {
  FigmaCodeConnectComponent,
  FigmaCodeConnectProp,
  FigmaEnumMappingEntry,
} from './figmaCodeConnectSchema'

const FIGMA_CONNECT_FILE_RE = /\.figma\.tsx$/
/** Bounded so a pathological package cannot blow parse time — the real corpus (29 files) is nowhere near this. */
const MAX_FIGMA_CONNECT_FILES = 200
/** Bounded per-package total, independent of file count (one file could in principle declare many `figma.connect` calls). */
const MAX_FIGMA_CONNECT_COMPONENTS = 500

function toPosix(p: string): string {
  return p.split('\\').join('/')
}

/** Every `*.figma.tsx` file under a package directory, POSIX-relative to it, sorted, capped. Reuses the shared bounded workspace walker (`@core/page-parser`'s `listWorkspaceFiles`) rather than a bespoke walk — it already skips `node_modules`/`.git`/build-output dirs and never follows symlinks, and Code Connect files are always distributed as raw source next to the component (never inside `dist/`), so its `dist` exclusion costs nothing here. */
export function listFigmaConnectFiles(pkgDir: string): string[] {
  return listWorkspaceFiles(pkgDir)
    .filter((rel) => FIGMA_CONNECT_FILE_RE.test(rel))
    .map(toPosix)
    .slice(0, MAX_FIGMA_CONNECT_FILES)
}

// ---------------------------------------------------------------------------
// Figma URL parsing
// ---------------------------------------------------------------------------

const FIGMA_FILE_KEY_RE = /figma\.com\/design\/([^/]+)\//
const FIGMA_NODE_ID_QUERY_RE = /[?&]node-id=([^&]+)/
/** A real Figma node id as it appears in a URL query param: digits-dash-digits (`53958-5861`). Anything else — a `figma connect create` scaffold's un-filled-in `REPLACE-ME`, or any other non-numeric placeholder a future template might use — is flagged via `nodeIdPlaceholder` rather than silently treated as a resolvable reference. */
const FIGMA_URL_NODE_ID_SHAPE_RE = /^\d+-\d+$/

interface ParsedFigmaUrl {
  figmaFileKey: string | undefined
  figmaNodeId: string | undefined
  nodeIdPlaceholder: boolean
}

/** `figma.connect`'s second argument, decoded. Never throws — an unparseable URL just yields every field `undefined`/`true`. */
export function parseFigmaConnectUrl(url: string): ParsedFigmaUrl {
  const fileKeyMatch = FIGMA_FILE_KEY_RE.exec(url)
  const nodeIdMatch = FIGMA_NODE_ID_QUERY_RE.exec(url)
  let rawNodeId: string | undefined
  try {
    rawNodeId = nodeIdMatch?.[1] ? decodeURIComponent(nodeIdMatch[1]) : undefined
  } catch {
    rawNodeId = nodeIdMatch?.[1]
  }
  const shaped = rawNodeId !== undefined && FIGMA_URL_NODE_ID_SHAPE_RE.test(rawNodeId)
  return {
    figmaFileKey: fileKeyMatch?.[1],
    figmaNodeId: shaped ? rawNodeId!.replace('-', ':') : rawNodeId,
    nodeIdPlaceholder: !shaped,
  }
}

// ---------------------------------------------------------------------------
// Comment extraction
// ---------------------------------------------------------------------------

/** Strips `//`/`/* … *\/` decoration and leading indentation from a comment range's raw text, joining a multi-line block into one line. */
function cleanCommentText(raw: string): string {
  return raw
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*\/\*+/, '')
        .replace(/\*+\/\s*$/, '')
        .replace(/^\s*\/\/\s?/, '')
        .replace(/^\s*\*\s?/, '')
        .trim(),
    )
    .filter((line) => line.length > 0)
    .join(' ')
    .trim()
}

function leadingCommentText(node: Node): string | undefined {
  const ranges = node.getLeadingCommentRanges()
  if (ranges.length === 0) return undefined
  const text = ranges
    .map((r) => cleanCommentText(r.getText()))
    .filter((t) => t.length > 0)
    .join(' ')
  return text.length > 0 ? text : undefined
}

/**
 * Per-enum-value inline caveat comments, e.g. `Disabled: 'primary', //
 * (approx) Figma models disabled as a Type; code uses the disabled attr`.
 * ts-morph's `getTrailingCommentRanges()` does not reliably attach a
 * same-line trailing comment to the PRECEDING `PropertyAssignment` inside an
 * object literal — measured against the real corpus (always empty) — so this
 * reads the raw TEXT of the mapping object literal ts-morph already isolated
 * for us, one line at a time: every file in the corpus writes one mapping
 * entry per line, so a same-line `//` after an entry is safe to attribute to
 * THAT entry's own Figma-value key via a plain string match. This is text
 * post-processing over an already AST-isolated node, not a second parser.
 */
function inlineMappingNotes(mappingObjectLiteral: ObjectLiteralExpression): Map<string, string> {
  const notes = new Map<string, string>()
  const KEY_BEFORE_COLON_RE = /^\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][A-Za-z0-9_$]*))\s*:/
  for (const line of mappingObjectLiteral.getText().split('\n')) {
    const commentIdx = line.indexOf('//')
    if (commentIdx === -1) continue
    const comment = line.slice(commentIdx + 2).trim()
    if (!comment) continue
    const keyMatch = KEY_BEFORE_COLON_RE.exec(line.slice(0, commentIdx))
    const key = keyMatch?.[1] ?? keyMatch?.[2] ?? keyMatch?.[3]
    if (key) notes.set(key, comment)
  }
  return notes
}

// ---------------------------------------------------------------------------
// Literal-value extraction — purely syntactic, mirrors `packageManifest.ts`'s
// own "never touches the checker" discipline
// ---------------------------------------------------------------------------

function literalPropertyValue(node: Node | undefined): string | number | boolean | undefined {
  if (!node) return undefined
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralValue()
  if (Node.isNumericLiteral(node)) return node.getLiteralValue()
  if (node.getKind() === SyntaxKind.TrueKeyword) return true
  if (node.getKind() === SyntaxKind.FalseKeyword) return false
  return undefined
}

/** A property-assignment NAME as written, quotes stripped — `.getName()` returns the literal text including surrounding quotes for a string-keyed property (`"'Inverted Primary'"`), which this normalizes to `Inverted Primary`. */
function unquotedPropertyName(name: string): string {
  return name.replace(/^['"]/, '').replace(/['"]$/, '')
}

// ---------------------------------------------------------------------------
// `props: { … }` extraction
// ---------------------------------------------------------------------------

const RECOGNIZED_PROP_METHODS = new Set(['enum', 'string', 'boolean'])

/** One `props` entry (`name: figma.enum(...)` / `figma.string(...)` / `figma.boolean(...)`), or `kind: 'unknown'` for anything else — never dropped outright, so a caller still sees the prop NAME exists even when this extractor can't classify its value. */
function extractProp(name: string, initializer: Node | undefined): FigmaCodeConnectProp {
  const base = { name, figmaProperty: '', kind: 'unknown' as const }
  if (!initializer || !Node.isCallExpression(initializer)) return base
  const callee = initializer.getExpression()
  if (!Node.isPropertyAccessExpression(callee)) return base
  const method = callee.getName()
  if (!RECOGNIZED_PROP_METHODS.has(method)) return base

  const args = initializer.getArguments()
  const figmaPropertyArg = args[0]
  const figmaProperty = figmaPropertyArg && Node.isStringLiteral(figmaPropertyArg) ? figmaPropertyArg.getLiteralValue() : ''
  const kind = method as 'enum' | 'string' | 'boolean'

  if (kind !== 'enum') return { name, figmaProperty, kind }

  const mappingArg = args[1]
  if (!mappingArg || !Node.isObjectLiteralExpression(mappingArg)) return { name, figmaProperty, kind, mapping: [] }

  const inlineNotes = inlineMappingNotes(mappingArg)
  const mapping: FigmaEnumMappingEntry[] = []
  for (const entry of mappingArg.getProperties()) {
    if (!Node.isPropertyAssignment(entry)) continue
    const figmaValue = unquotedPropertyName(entry.getName())
    const codeValue = literalPropertyValue(entry.getInitializer())
    if (codeValue === undefined) continue // an expression this extractor can't evaluate as a literal — dropped, never guessed
    const note = inlineNotes.get(figmaValue)
    mapping.push({ figmaValue, codeValue, ...(note ? { note } : {}) })
  }
  return { name, figmaProperty, kind, mapping }
}

// ---------------------------------------------------------------------------
// `figma.connect(Component, url, { props, example })` — one call, one spec
// ---------------------------------------------------------------------------

function specFromConnectCall(callExpr: Node, relFile: string): FigmaCodeConnectComponent | undefined {
  if (!Node.isCallExpression(callExpr)) return undefined
  const [componentArg, urlArg, optionsArg] = callExpr.getArguments()
  if (!componentArg || !urlArg || !optionsArg) return undefined
  if (!Node.isStringLiteral(urlArg) || !Node.isObjectLiteralExpression(optionsArg)) return undefined

  const component = componentArg.getText()
  const figmaUrl = urlArg.getLiteralValue()
  const { figmaFileKey, figmaNodeId, nodeIdPlaceholder } = parseFigmaConnectUrl(figmaUrl)

  const propsMember = optionsArg.getProperty('props')
  const propsObject =
    propsMember && Node.isPropertyAssignment(propsMember) && Node.isObjectLiteralExpression(propsMember.getInitializer())
      ? (propsMember.getInitializer() as ObjectLiteralExpression)
      : undefined

  const props: FigmaCodeConnectProp[] = []
  if (propsObject) {
    for (const propEntry of propsObject.getProperties()) {
      if (!Node.isPropertyAssignment(propEntry)) continue
      const name = unquotedPropertyName(propEntry.getName())
      const spec = extractProp(name, propEntry.getInitializer())
      const note = leadingCommentText(propEntry)
      props.push(note ? { ...spec, note } : spec)
    }
  }

  const exampleMember = optionsArg.getProperty('example')
  const example =
    exampleMember && Node.isPropertyAssignment(exampleMember) ? exampleMember.getInitializer()?.getText() : undefined

  // `verifiedNote` (the file-level "verified against…" prose) is filled in by
  // the caller (`parseFigmaCodeConnectFile`) — it lives on the FILE's first
  // statement, not on this call site, and every call in the same file shares it.
  return {
    component,
    file: relFile,
    figmaUrl,
    figmaFileKey,
    figmaNodeId,
    nodeIdPlaceholder,
    props,
    example,
  }
}

/** File-level "verified against…" prose — the leading comment block on the file's FIRST statement (always the `import figma from '@figma/code-connect'` line in every real file), not on the `figma.connect(...)` call site itself (which usually has none of its own). */
function fileLeadingNote(sourceFile: SourceFile): string | undefined {
  const first = sourceFile.getStatements()[0]
  return first ? leadingCommentText(first) : undefined
}

/**
 * Every `figma.connect(...)` call in one already-added source file. Code
 * Connect officially allows more than one per file (different variants of
 * the same or different components); the real corpus has exactly one, but
 * this does not assume that. Returns `[]` (not an error) for a `.figma.tsx`
 * file with no recognizable `figma.connect` call at all.
 */
export function parseFigmaCodeConnectFile(sourceFile: SourceFile, relFile: string): FigmaCodeConnectComponent[] {
  const note = fileLeadingNote(sourceFile)
  const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression).filter((c) => {
    const expr = c.getExpression()
    return Node.isPropertyAccessExpression(expr) && expr.getName() === 'connect' && expr.getExpression().getText() === 'figma'
  })
  const specs: FigmaCodeConnectComponent[] = []
  for (const call of calls) {
    const spec = specFromConnectCall(call, relFile)
    if (spec) specs.push(note ? { ...spec, verifiedNote: note } : spec)
  }
  return specs
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface FigmaCodeConnectResult {
  components: FigmaCodeConnectComponent[]
  warnings: ProbeWarning[]
}

/**
 * `pkgDir + packageName -> FigmaCodeConnectComponent[]`. Never throws — an
 * absent/unparseable file all degrade to a warning, matching
 * `buildPackageManifest`'s own "degrade to a warning" contract. Returns `{
 * components: [], warnings: [] }`, NOT an error, for the ordinary case of a
 * package that ships no `*.figma.tsx` files at all.
 */
export function collectFigmaCodeConnectComponents(pkgDir: string, packageName: string): FigmaCodeConnectResult {
  const warnings: ProbeWarning[] = []
  const files = listFigmaConnectFiles(pkgDir)
  if (files.length === 0) return { components: [], warnings }

  const components: FigmaCodeConnectComponent[] = []
  for (const relFile of files) {
    if (components.length >= MAX_FIGMA_CONNECT_COMPONENTS) break
    try {
      const project = new Project({ useInMemoryFileSystem: false, skipAddingFilesFromTsConfig: true, compilerOptions: { allowJs: true } })
      const sourceFile = project.addSourceFileAtPath(join(pkgDir, ...relFile.split('/')))
      const specs = parseFigmaCodeConnectFile(sourceFile, relFile)
      if (specs.length === 0) {
        warnings.push({
          code: 'figma-connect-unparseable',
          message: `"${packageName}/${relFile}" matches *.figma.tsx but no figma.connect(...) call could be read from it.`,
          fix: 'Confirm the file follows the standard figma.connect(Component, url, { props, example }) shape.',
        })
        continue
      }
      components.push(...specs.slice(0, MAX_FIGMA_CONNECT_COMPONENTS - components.length))
    } catch (err) {
      console.error('[studio:figmaCodeConnect]', relFile, err)
      warnings.push({
        code: 'figma-connect-parse-failed',
        message: `Could not parse "${packageName}/${relFile}": ${err instanceof Error ? err.message : String(err)}`,
        fix: 'Check the file for a syntax error.',
      })
    }
  }
  return { components, warnings }
}
