/**
 * storyDiscovery — reading a project's Storybook CSF files STATICALLY, so
 * every story a design system already wrote can become a board frame.
 *
 * A `.stories.tsx` is a component plus its args plus its variants, written
 * down by the team that owns the component. That is one board frame per story
 * for free, and it is also the answer to the insert picker's cold-start
 * problem: a package with zero call sites in the imported source has no picker
 * row, and every accepted story creates a real call site.
 *
 * ---------------------------------------------------------------------------
 * PARSE, NEVER EXECUTE — the accepted subset, stated exactly.
 *
 * Storybook's own runtime composes a story by CALLING things: decorators wrap
 * it, `play` drives it, `loaders` feed it, `render` builds it. Studio runs none
 * of that (PROJECT-BRIEF invariant 1), so a story is accepted only when its
 * body can be READ. Two shapes qualify, and everything else is refused BY NAME
 * (see {@link StoryRefusalReason}) rather than half-rendered:
 *
 *   1. **args-only** — a CSF3 object export with no `render`, whose meta
 *      declares `component:`. The body is that component invoked with
 *      `{...meta.args, ...story.args}`. Every arg value must be a literal
 *      {@link readLiteral} can see; a function-valued arg (`onClick: fn()`) is
 *      DROPPED, never stubbed — the same trade `staticValueToPropValue` makes
 *      for a JSX prop.
 *
 *   2. **jsx-only** — a function whose body is nothing but JSX: either a
 *      concise arrow expression (`render: args => <Button {...args}/>`) or a
 *      block whose ONLY statement is `return <JSX>`. Reached both as a
 *      `render:` property and as a bare function export
 *      (`export const Default = () => <Avatar src="…"/>`), which is the same
 *      shape and is extremely common in real repos. The JSX genuinely exists
 *      in the `.stories.tsx`, so it goes through the ORDINARY page pipeline
 *      (`getReturnedJsxRoots` -> `parseJsxTree` -> `inlineLocalComponents`)
 *      and its nodes get real, writable `relFile:line:col` ids.
 *
 * A body with any other statement in it — a hook, a `const`, a conditional, a
 * loop, an `await` — is `render-logic` and is refused. That line is not
 * conservatism: choosing what such a body would have produced is exactly the
 * banned Tier D guess.
 *
 * CSF2 (`storiesOf(...).add(...)`) is refused for the whole file: its stories
 * are registered by executing a builder chain, and there is no declarative
 * export to read.
 * ---------------------------------------------------------------------------
 *
 * This module OWNS the story-id assignment (`StorySummary.pageId`) so the load
 * pipeline (`storyPages.ts`) and the board reconciler (`boardFrames.ts`'s
 * `syncStoryBoardFrames`) cannot disagree about which frame belongs to which
 * story — the same "one owner for a derived id" rule `studioPageIds.ts` states
 * for pages.
 */
import * as path from 'node:path'
import { Node, type Expression, type ObjectLiteralExpression, type Project, type SourceFile } from 'ts-morph'
import {
  listWorkspaceFiles,
  resolveComponentSources,
  type ComponentSource,
  type FunctionLike,
  type ParsedPropValue,
} from '@core/page-parser'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import { pageIdFromRelPath } from '../studioPageIds'
import {
  hasProperty,
  identifierChainProperty,
  isFunctionLike,
  isJsxExpression,
  propertyValue,
  readObjectLiteral,
  stringProperty,
  unwrapParens,
  unwrapTypeCasts,
} from './storyLiterals'

/** `Button.stories.tsx`, `Button.dev.stories.jsx`, `helpers.stories.ts` — the file-name convention every Storybook config globs for. */
const STORY_FILE_RE = /\.stories\.(tsx|ts|jsx)$/

/**
 * A leading underscore is the convention for a helper a story file exports for
 * its siblings, and it also covers Storybook's own `__namedExportsOrder`
 * ordering hint. Never a story, whatever its value.
 */
const NON_STORY_EXPORT_RE = /^_/

/** Meta/story keys whose presence means Storybook would have to RUN something for the story to exist. */
const RUNTIME_KEYS: ReadonlyArray<{ key: string; reason: StoryRefusalReason }> = [
  { key: 'decorators', reason: 'decorators' },
  { key: 'play', reason: 'play-function' },
  { key: 'loaders', reason: 'loaders' },
  { key: 'beforeEach', reason: 'loaders' },
]

const StoryRefusalReasonSchema = Type.Union([
  /** The file registers stories through `storiesOf(...)` — a builder chain, not a readable export. */
  Type.Literal('csf2-storiesof'),
  /** No default export, or one that is not an object literal (directly or through a same-file `const`). */
  Type.Literal('no-default-export'),
  /** An args-only story whose meta declares no `component:` — there is nothing to invoke. */
  Type.Literal('no-component'),
  /** `meta.component` names an identifier no import or same-file declaration in the story file resolves. */
  Type.Literal('unresolved-component'),
  /** The export's value is neither an object literal nor a function. */
  Type.Literal('not-a-story'),
  /** The story body has statements beyond a single `return <JSX>` — running it is the only way to know what it renders. */
  Type.Literal('render-logic'),
  /** The story body is a function that returns no JSX at all. */
  Type.Literal('no-jsx'),
  /** `play:` — an interaction script Storybook executes after mount. */
  Type.Literal('play-function'),
  /** `decorators:` — wrapper components applied at render time. */
  Type.Literal('decorators'),
  /** `loaders:`/`beforeEach:` — async data fetched before the story renders. */
  Type.Literal('loaders'),
  /** `args` contains a spread (`{...Default.args}`) — its resulting keys are unknowable without evaluating it. */
  Type.Literal('spread-args'),
  /** `args` is not an object literal. */
  Type.Literal('args-not-object'),
  /** ts-morph could not read the file at all. */
  Type.Literal('unreadable'),
])
export type StoryRefusalReason = Static<typeof StoryRefusalReasonSchema>

export const StoryRefusalSchema = Type.Object({
  /** Workspace-relative POSIX path of the `.stories.*` file. */
  file: Type.String(),
  /** The refused export's name, or absent when the WHOLE file was refused. */
  story: Type.Optional(Type.String()),
  reason: StoryRefusalReasonSchema,
  /** One sentence a person can act on, naming what was in the source. */
  detail: Type.String(),
})
export type StoryRefusal = Static<typeof StoryRefusalSchema>

export const StorySummarySchema = Type.Object({
  file: Type.String(),
  /** The exported binding's name, e.g. `Primary`. */
  exportName: Type.String(),
  /** `meta.title`, e.g. `Components/Button` — the grouping key one board row is built from. */
  title: Type.String(),
  /** `story.name`/`storyName` when present, else `exportName`. */
  storyName: Type.String(),
  /** The frame's label: `<title> / <storyName>`. */
  frameTitle: Type.String(),
  /** The page id this story's frame renders — unique across the whole discovered story set. */
  pageId: Type.String(),
})
export type StorySummary = Static<typeof StorySummarySchema>

/**
 * How an accepted story's body is materialized. The two variants are the two
 * accepted subsets in this module's header, and they reach the board through
 * genuinely different paths — see `storyPages.ts`.
 */
export type StoryBody =
  | {
      kind: 'args'
      /** The identifier `meta.component` names, as written (`Button`, `Ariakit.Button`). */
      componentName: string
      /** What that identifier resolves to — a workspace file or an npm package. */
      componentSource: ComponentSource
      /** `{...meta.args, ...story.args}`, literals only. */
      args: Record<string, ParsedPropValue>
    }
  | { kind: 'jsx'; fn: FunctionLike }

/** One accepted story, with everything `storyPages.ts` needs to materialize it and nothing it does not. */
export interface DiscoveredStory {
  summary: StorySummary
  /** Workspace-relative POSIX path of the `.stories.*` file. */
  relFile: string
  /** Absolute path of the same file — what `project.getSourceFile` takes. */
  absFile: string
  /**
   * 1-based line/column of the story export's own name identifier. A REAL
   * position in a REAL file: an args-only story has no JSX to anchor to, and
   * inventing a location would hand a codemod a target that is not there
   * (trap #2). See `storyPages.ts` for why nothing may be written at it.
   */
  line: number
  col: number
  body: StoryBody
}

export interface StoryDiscovery {
  stories: DiscoveredStory[]
  refusals: StoryRefusal[]
}

/**
 * Every `.stories.{tsx,ts,jsx}` in the project, workspace-relative POSIX,
 * sorted — reusing `listWorkspaceFiles`'s excluded-dir walk so
 * `node_modules`/`.git`/`dist` are skipped exactly as they are for pages.
 *
 * Deliberately separate from {@link discoverStories}: this is the cheap
 * question ("does this project have stories at all?"), and it is what keeps a
 * project WITHOUT stories at zero cost — no ts-morph work happens unless this
 * returns something.
 */
export function storyFilesIn(dir: string): string[] {
  return listWorkspaceFiles(dir).filter((relPath) => STORY_FILE_RE.test(relPath))
}

/** Everything one file's scan needs, bundled so the reader below stays readable. */
interface ScanContext {
  project: Project
  /** Workspace root — what `resolveComponentSources` classifies imports against. */
  dir: string
  stories: DiscoveredStory[]
  refusals: StoryRefusal[]
  takenPageIds: Set<string>
}

/**
 * Reads every story file in `dir` against the already-built workspace
 * `project`, returning the stories that can be materialized and a NAMED
 * refusal for every one that cannot.
 *
 * Never throws: an unreadable file becomes one `unreadable` refusal and the
 * scan continues, mirroring `parsePageFile`'s "a bad page is an empty page,
 * not a crash" contract.
 *
 * `storyFiles` defaults to {@link storyFilesIn}'s own scan; a caller that has
 * ALREADY run it (the load pipeline, which uses it as its zero-cost gate)
 * passes the result rather than walking the whole project tree twice.
 */
export function discoverStories(
  dir: string,
  project: Project,
  storyFiles: readonly string[] = storyFilesIn(dir),
): StoryDiscovery {
  const ctx: ScanContext = { project, dir, stories: [], refusals: [], takenPageIds: new Set() }

  for (const relFile of storyFiles) {
    try {
      readStoryFile(ctx, relFile, path.join(dir, ...relFile.split('/')))
    } catch (err) {
      ctx.refusals.push({
        file: relFile,
        reason: 'unreadable',
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { stories: ctx.stories, refusals: ctx.refusals }
}

/** One story file: parse its meta, then every named export that could be a story. Appends to `ctx` in place. */
function readStoryFile(ctx: ScanContext, relFile: string, absFile: string): void {
  const sourceFile = ctx.project.getSourceFile(absFile) ?? ctx.project.addSourceFileAtPath(absFile)

  if (sourceFile.getFirstDescendant((node) => Node.isIdentifier(node) && node.getText() === 'storiesOf')) {
    ctx.refusals.push({
      file: relFile,
      reason: 'csf2-storiesof',
      detail: 'CSF2: stories are registered by calling storiesOf(...).add(...), which Studio never executes.',
    })
    return
  }

  const meta = readMeta(sourceFile)
  if (!meta) {
    ctx.refusals.push({
      file: relFile,
      reason: 'no-default-export',
      detail: 'No default-exported meta object literal was found.',
    })
    return
  }
  const metaRuntimeKey = firstRuntimeKey(meta.object)
  if (metaRuntimeKey) {
    ctx.refusals.push({
      file: relFile,
      reason: metaRuntimeKey.reason,
      detail: `The file's meta declares \`${metaRuntimeKey.key}\`, which only exists when Storybook runs it.`,
    })
    return
  }

  const metaArgs = readArgsProperty(meta.object)
  if (metaArgs.kind === 'refused') {
    ctx.refusals.push({ file: relFile, reason: metaArgs.reason, detail: `The file's meta \`args\` ${metaArgs.detail}` })
    return
  }

  const file: StoryFileContext = {
    relFile,
    absFile,
    sourceFile,
    title: meta.title ?? defaultTitleFor(relFile),
    component: meta.component,
    metaArgs: metaArgs.args,
  }

  // `export const Primary = …` — the CSF3 spelling.
  for (const declaration of sourceFile.getVariableDeclarations()) {
    if (declaration.getVariableStatement()?.isExported() !== true) continue
    if (declaration.getName() === meta.bindingName) continue
    const initializer = declaration.getInitializer()
    if (!initializer) continue
    readStoryExport(ctx, file, declaration.getName(), unwrapTypeCasts(initializer), declaration.getNameNode().getStart())
  }

  // `export function Primary() { return <X/> }` — the same jsx-only shape,
  // spelled as a function declaration. Common enough in real design systems
  // (Shopify Polaris writes every story this way) that skipping it would
  // report a whole repo as having no readable stories at all, silently.
  for (const declaration of sourceFile.getFunctions()) {
    const exportName = declaration.getName()
    if (exportName === undefined || !declaration.isExported() || declaration.isDefaultExport()) continue
    readStoryExport(ctx, file, exportName, declaration, declaration.getNameNode()?.getStart() ?? declaration.getStart())
  }
}

/** The file-wide facts every export in one story file is read against. */
interface StoryFileContext {
  relFile: string
  absFile: string
  sourceFile: SourceFile
  /** `meta.title`, or the filename fallback. */
  title: string
  /** `meta.component`'s expression text, when the file declares one. */
  component: string | undefined
  /** `meta.args`, merged under every story's own. */
  metaArgs: Record<string, ParsedPropValue>
}

/** Classifies ONE exported binding and records it as an accepted story or a named refusal. */
function readStoryExport(
  ctx: ScanContext,
  file: StoryFileContext,
  exportName: string,
  value: Expression | FunctionLike,
  namePos: number,
): void {
  if (NON_STORY_EXPORT_RE.test(exportName)) return

  const read = readStoryBody(value, file.component)
  if (read.kind === 'refused') {
    ctx.refusals.push({ file: file.relFile, story: exportName, reason: read.reason, detail: read.detail })
    return
  }

  const body = materializeBody(ctx, file.absFile, read, file.metaArgs)
  if (body.kind === 'refused') {
    ctx.refusals.push({ file: file.relFile, story: exportName, reason: body.reason, detail: body.detail })
    return
  }

  const { line, column } = file.sourceFile.getLineAndColumnAtPos(namePos)
  const storyName = read.storyName ?? exportName
  ctx.stories.push({
    summary: {
      file: file.relFile,
      exportName,
      title: file.title,
      storyName,
      frameTitle: `${file.title} / ${storyName}`,
      pageId: assignStoryPageId(file.relFile, exportName, ctx.takenPageIds),
    },
    relFile: file.relFile,
    absFile: file.absFile,
    line,
    col: column,
    body: body.body,
  })
}

/**
 * Turns the SHAPE the reader recognised into the body `storyPages.ts`
 * materializes — which for the args-only shape means resolving what
 * `meta.component`'s identifier actually refers to. Kept separate from
 * {@link readStoryBody} because that function is pure AST reading and this one
 * needs the ts-morph project.
 */
function materializeBody(
  ctx: ScanContext,
  absFile: string,
  read: Extract<StoryBodyResult, { kind: 'accepted' }>,
  metaArgs: Record<string, ParsedPropValue>,
): { kind: 'accepted'; body: StoryBody } | { kind: 'refused'; reason: StoryRefusalReason; detail: string } {
  if (read.shape.kind === 'jsx') return { kind: 'accepted', body: { kind: 'jsx', fn: read.shape.fn } }

  const componentName = read.shape.componentName
  const componentSource = resolveStoryComponent(ctx, absFile, componentName)
  if (!componentSource) {
    return {
      kind: 'refused',
      reason: 'unresolved-component',
      detail: `meta.component names \`${componentName}\`, which is neither imported nor declared in this file.`,
    }
  }
  return {
    kind: 'accepted',
    body: { kind: 'args', componentName, componentSource, args: { ...metaArgs, ...read.shape.args } },
  }
}

/**
 * What `meta.component`'s identifier actually refers to, asked with the SAME
 * import/barrel/rename logic every page's component call site is classified
 * with (`resolveComponentSources`) rather than a second, drifting reader. A
 * one-node synthetic page is the input that function takes; the node id is
 * arbitrary here because only the returned classification is read back.
 */
function resolveStoryComponent(ctx: ScanContext, absFile: string, componentName: string): ComponentSource | undefined {
  const probeId = 'story-component-probe'
  const sources = resolveComponentSources(ctx.project, absFile, ctx.dir, {
    rootIds: [probeId],
    nodes: {
      [probeId]: {
        id: probeId,
        kind: 'component',
        name: componentName,
        props: {},
        children: [],
        loc: { file: '', line: 1, col: 1 },
        locked: false,
      },
    },
  })
  return sources[probeId]
}

/** `packages/react/src/Avatar/Avatar.dev.stories.tsx` -> `Avatar` — the fallback grouping title when the meta declares none. */
function defaultTitleFor(relFile: string): string {
  const base = relFile.split('/').pop() ?? relFile
  return base.replace(STORY_FILE_RE, '').replace(/\.[a-z0-9]+$/i, '')
}

/**
 * A story's page id: the story FILE's own path id plus the export name, so it
 * is derivable from `(relFile, exportName)` alone and stable across loads.
 * Deduped against the ids already handed out in this scan with the same
 * numeric-suffix rule `assignPageIds` uses, because two different story files
 * can slugify to the same string exactly as two page files can.
 */
function assignStoryPageId(relFile: string, exportName: string, taken: Set<string>): string {
  const base = `${pageIdFromRelPath(relFile)}-${kebab(exportName)}`
  if (!taken.has(base)) {
    taken.add(base)
    return base
  }
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (taken.has(candidate)) continue
    taken.add(candidate)
    return candidate
  }
}

function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** The default-exported meta, however it was spelled. */
interface StoryMeta {
  object: ObjectLiteralExpression
  /** `meta.component`'s expression text, when it declares one. */
  component: string | undefined
  /** `meta.title`, when it is a string literal. */
  title: string | undefined
  /** The name of the `const` the default export points at, so it is never mistaken for a story. */
  bindingName: string | undefined
}

/**
 * Reads the default export in the three spellings real CSF files use:
 * `export default { … }`, `export default { … } satisfies Meta<…>`, and
 * `const meta: Meta<…> = { … }; export default meta`.
 */
function readMeta(sourceFile: SourceFile): StoryMeta | undefined {
  const assignment = sourceFile.getExportAssignments().find((a) => !a.isExportEquals())
  if (!assignment) return undefined

  const expression = unwrapTypeCasts(assignment.getExpression())
  let object: ObjectLiteralExpression | undefined
  let bindingName: string | undefined

  if (Node.isObjectLiteralExpression(expression)) {
    object = expression
  } else if (Node.isIdentifier(expression)) {
    bindingName = expression.getText()
    const initializer = sourceFile.getVariableDeclaration(bindingName)?.getInitializer()
    const unwrapped = initializer ? unwrapTypeCasts(initializer) : undefined
    if (unwrapped && Node.isObjectLiteralExpression(unwrapped)) object = unwrapped
  }
  if (!object) return undefined

  return {
    object,
    component: identifierChainProperty(object, 'component'),
    title: stringProperty(object, 'title'),
    bindingName,
  }
}

/** The SHAPE an exported story value was recognised as, before the project is consulted. */
type StoryShape =
  | { kind: 'jsx'; fn: FunctionLike }
  | { kind: 'args'; componentName: string; args: Record<string, ParsedPropValue> }

type StoryBodyResult =
  | { kind: 'accepted'; shape: StoryShape; storyName: string | undefined }
  | { kind: 'refused'; reason: StoryRefusalReason; detail: string }

/** Classifies ONE exported story value against the two accepted subsets in this module's header. */
function readStoryBody(initializer: Expression | FunctionLike, metaComponent: string | undefined): StoryBodyResult {
  // Shape 2, spelled as a bare function export
  // (`export const Default = () => <Avatar/>`). Same body rule as `render:`.
  if (isFunctionLike(initializer)) return jsxShape(initializer, undefined)

  if (!Node.isObjectLiteralExpression(initializer)) {
    return {
      kind: 'refused',
      reason: 'not-a-story',
      detail: 'The export is neither a CSF3 object nor a function returning JSX.',
    }
  }

  const runtimeKey = firstRuntimeKey(initializer)
  if (runtimeKey) {
    return {
      kind: 'refused',
      reason: runtimeKey.reason,
      detail: `The story declares \`${runtimeKey.key}\`, which only exists when Storybook runs it.`,
    }
  }

  const storyName = stringProperty(initializer, 'name') ?? stringProperty(initializer, 'storyName')

  const render = propertyValue(initializer, 'render')
  if (render) {
    const fn = unwrapTypeCasts(render)
    if (!isFunctionLike(fn)) {
      return { kind: 'refused', reason: 'render-logic', detail: '`render` is not a function.' }
    }
    return jsxShape(fn, storyName)
  }

  // Shape 1 — args-only.
  if (metaComponent === undefined) {
    return {
      kind: 'refused',
      reason: 'no-component',
      detail: "The story has no `render`, and the file's meta declares no `component` to invoke.",
    }
  }
  const args = readArgsProperty(initializer)
  if (args.kind === 'refused') {
    return { kind: 'refused', reason: args.reason, detail: `\`args\` ${args.detail}` }
  }

  return { kind: 'accepted', storyName, shape: { kind: 'args', componentName: metaComponent, args: args.args } }
}

/**
 * Accepts a function ONLY when its body is JSX and nothing else — the
 * `jsx-only` subset. Which `return` actually renders is deliberately left to
 * the caller's `getReturnedJsxRoots` (`storyPages.ts`); this gate answers the
 * narrower question of whether there is anything BESIDES a return in the way.
 */
function jsxShape(fn: FunctionLike, storyName: string | undefined): StoryBodyResult {
  const body = fn.getBody()
  if (!body) return { kind: 'refused', reason: 'no-jsx', detail: 'The function has no body.' }

  if (!Node.isBlock(body)) {
    if (!isJsxExpression(unwrapParens(body))) {
      return { kind: 'refused', reason: 'no-jsx', detail: 'The function returns something other than JSX.' }
    }
    return { kind: 'accepted', shape: { kind: 'jsx', fn }, storyName }
  }

  const statements = body.getStatements()
  if (statements.length !== 1) {
    return {
      kind: 'refused',
      reason: 'render-logic',
      detail: `The body has ${statements.length} statements; only a single \`return <JSX>\` can be read without running it.`,
    }
  }
  const only = statements[0]!
  if (!Node.isReturnStatement(only)) {
    return { kind: 'refused', reason: 'render-logic', detail: "The body's only statement is not a `return`." }
  }
  const returned = only.getExpression()
  if (!returned || !isJsxExpression(unwrapParens(returned))) {
    return { kind: 'refused', reason: 'no-jsx', detail: 'The `return` does not return JSX.' }
  }
  return { kind: 'accepted', shape: { kind: 'jsx', fn }, storyName }
}

type ArgsResult =
  | { kind: 'accepted'; args: Record<string, ParsedPropValue> }
  | { kind: 'refused'; reason: StoryRefusalReason; detail: string }

/** `args:` on a meta or a story — an object literal of readable values, or a named refusal. Absent is fine and yields `{}`. */
function readArgsProperty(object: ObjectLiteralExpression): ArgsResult {
  const value = propertyValue(object, 'args')
  if (!value) return { kind: 'accepted', args: {} }
  const unwrapped = unwrapTypeCasts(value)
  if (!Node.isObjectLiteralExpression(unwrapped)) {
    return { kind: 'refused', reason: 'args-not-object', detail: 'is not an object literal.' }
  }
  const read = readObjectLiteral(unwrapped)
  if (read === undefined) {
    return {
      kind: 'refused',
      reason: 'spread-args',
      detail: 'contains a spread, whose resulting keys are unknowable without evaluating it.',
    }
  }
  return { kind: 'accepted', args: read }
}

/** The first `decorators`/`play`/`loaders`/`beforeEach` key present, with the refusal it earns. Asked of the KEY, not its value, so a shorthand (`{ play }`) still refuses. */
function firstRuntimeKey(object: ObjectLiteralExpression): { key: string; reason: StoryRefusalReason } | undefined {
  return RUNTIME_KEYS.find(({ key }) => hasProperty(object, key))
}

