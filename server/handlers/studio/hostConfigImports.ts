/**
 * hostConfigImports — the local modules a project's host-executed config files
 * load, so the agent write gate can refuse them like the configs themselves
 * (security re-review of #233, R1).
 *
 * ## Why a file NAME is not enough
 *
 * `hostExecutedWorkspaceFile` refuses `vite.config.ts` by name. But the config
 * runs whatever it imports: Studio's own scaffolded `vite.config.js` imports
 * `./prototype/studioRuntime.generated.js`, and a user's `vite.config.ts`
 * routinely imports `./vite/plugins.ts`. Vite watches those dependencies and
 * restarts — re-running them in Node — when one changes. Refusing the config
 * and allowing its imports leaves the zero-click path exactly as open.
 *
 * ## What loads code in Node, and is followed here
 *
 * - **The configs Studio runs.** Every host config (`isHostConfigFileName`) at
 *   the project root AND at the app root (`resolveAppRoot`) — `devServer.ts`
 *   runs Vite in a nested app's folder, so that folder's config is the one
 *   that executes — plus the file a dev script names with `--config`/`-c`,
 *   which runs whatever its name.
 * - **A symlinked config.** Its imports resolve from where the link POINTS,
 *   the way esbuild resolves them, and the file it points at is protected too.
 * - **Tailwind's CSS directives.** In a project that depends on Tailwind,
 *   `@plugin "./x.js"` and `@config "./x.js"` in any stylesheet — or in a
 *   `<style>` block of an HTML or component file — load that module in Node on
 *   the next build, however the path is wrapped (`parseTailwindLoadDirectives`). The targets are protected here; a write
 *   that ADDS such a directive is refused by the content half of the gate
 *   (`agentContentRefusal`, `agentWriteScope.ts`).
 * - **What each of those imports**, to depth {@link MAX_DEPTH}, found by a
 *   bounded textual scan for `import … from './x'`, `import './x'`,
 *   `import('./x')` (quotes or a backtick with no substitution) and
 *   `require('./x')`. A PostCSS config also names local plugins as plain
 *   strings — `plugins: { './postcss/local.js': {} }` — so in one every quoted
 *   relative string counts.
 *
 * Nothing is executed or parsed as a program. Only relative specifiers count:
 * a bare specifier resolves into `node_modules`, which no agent writes. A
 * specifier is protected under every name it could resolve to (as written,
 * with each JS/TS extension, as a directory index, and `.js` written for a
 * `.ts` source), whether or not the file exists yet — creating a module a
 * config already imports runs it too.
 *
 * Not covered, and said so: a tsconfig `paths` alias a config imports through,
 * a specifier computed at runtime, and a chain deeper than {@link MAX_DEPTH}.
 * This narrows the zero-click path; it is not a sandbox.
 *
 * ## Cost
 *
 * A `readdir` of the root and the app root plus a handful of small reads; in a
 * Tailwind project also one walk for stylesheets. The result is cached per
 * project and revalidated by `stat`ing every directory and file it read, so
 * the HTTP tools pay the scan once per change; the CLI hook runs in a fresh
 * process per write and pays it every time, which is milliseconds.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { comparableWorkspaceRel, isHostConfigFileName, listWorkspaceFiles } from '@core/page-parser'
import { resolveAppRoot } from './appRoot'
import { resolveDevScript } from './liveCapability'
import { viteArgsFromScript } from './viteLaunch'

/** Config → its imports → theirs … Deep enough for a plugins folder with helpers; a deeper chain is a project-specific residual. */
const MAX_DEPTH = 6
/** A config or plugin module bigger than this is not read: nothing legitimate is. */
const MAX_SCANNED_BYTES = 200_000
/** Bounded on every quantifier, so the scan is linear in the file size. */
const RELATIVE_SPECIFIER = /(?:\bfrom\s{0,20}|\bimport\s{0,20}\(?\s{0,20}|\brequire\s{0,20}\(\s{0,20})(['"`])(\.{1,2}\/[^'"`\r\n]{1,400})\1/g
/** Any quoted relative string — the PostCSS plugin-map key form. */
const QUOTED_RELATIVE = /(['"`])(\.{1,2}\/[^'"`\r\n]{1,400})\1/g
const CODE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
/** Files whose CSS a Vite + Tailwind build reads directives from: stylesheets, and the `<style>` blocks of HTML and component files. */
const CSS_CARRIER = /\.(?:css|pcss|postcss|scss|sass|less|html|vue|svelte|astro)$/i

interface ClosureEntry {
  /** Comparable project-relative path → what (transitively) loads it. */
  readonly importedBy: ReadonlyMap<string, string>
  /** Every directory and file read, with the mtime it was read at. */
  readonly stamps: ReadonlyArray<readonly [string, number]>
}

const cache = new Map<string, ClosureEntry>()

function mtimeOf(abs: string): number {
  try {
    return statSync(abs).mtimeMs
  } catch {
    return -1
  }
}

function isFile(abs: string): boolean {
  try {
    return statSync(abs).isFile()
  } catch {
    return false
  }
}

function realOrSelf(abs: string): string {
  try {
    return realpathSync.native(abs)
  } catch {
    return abs
  }
}

function readCapped(abs: string): string | null {
  try {
    if (statSync(abs).size > MAX_SCANNED_BYTES) return null
    return readFileSync(abs, 'utf8')
  } catch {
    return null
  }
}

/** Every relative specifier a config or module text names. */
function relativeSpecifiers(source: string, file: string): string[] {
  const pattern = /^(?:postcss\.config\.|\.postcssrc)/i.test(basename(file)) ? QUOTED_RELATIVE : RELATIVE_SPECIFIER
  const out: string[] = []
  for (const match of source.matchAll(pattern)) {
    const spec = match[2]!
    if (!spec.includes('${')) out.push(spec)
  }
  return out
}

/** Every absolute path `spec` could resolve to from `fromDir`. */
function candidatePaths(fromDir: string, spec: string): string[] {
  const base = resolve(fromDir, spec)
  const out = [base]
  for (const ext of CODE_EXTENSIONS) {
    out.push(`${base}${ext}`, join(base, `index${ext}`))
  }
  // TypeScript's convention: `./x.js` in source names `./x.ts`.
  const jsLike = /\.(?:[cm]?js|jsx)$/.exec(base)
  if (jsLike) {
    const stem = base.slice(0, base.length - jsLike[0].length)
    for (const ext of ['.ts', '.tsx', '.mts', '.cts']) out.push(`${stem}${ext}`)
  }
  return out
}

/** The file a `vite` dev script names with `--config x`, `--config=x` or `-c x`, resolved in `appRoot`. */
function devScriptConfig(appRoot: string): string | null {
  const script = resolveDevScript(appRoot)
  const args = script ? viteArgsFromScript(script.command) : null
  if (!args) return null
  for (const [index, arg] of args.entries()) {
    if (arg.startsWith('--config=')) return resolve(appRoot, arg.slice('--config='.length))
    if ((arg === '--config' || arg === '-c') && args[index + 1]) return resolve(appRoot, args[index + 1]!)
  }
  return null
}

/** Whether `dir`'s `package.json` depends on Tailwind (`tailwindcss` or any `@tailwindcss/*`). */
function dependsOnTailwind(dir: string): boolean {
  const text = readCapped(join(dir, 'package.json'))
  if (text === null) return false
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return false
    return ['dependencies', 'devDependencies', 'peerDependencies'].some((field) => {
      const deps: unknown = (parsed as Record<string, unknown>)[field]
      return typeof deps === 'object' && deps !== null && Object.keys(deps).some((name) => name === 'tailwindcss' || name.startsWith('@tailwindcss/'))
    })
  } catch {
    return false
  }
}

function scan(root: string): ClosureEntry {
  const importedBy = new Map<string, string>()
  const stamps: Array<readonly [string, number]> = []
  const stamp = (abs: string): void => { stamps.push([abs, mtimeOf(abs)]) }

  const toRel = (abs: string): string | null => {
    const rel = relative(root, abs)
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
    return comparableWorkspaceRel(rel)
  }
  /** How a file is named in a refusal: as the project spells it. */
  const shown = (abs: string): string => relative(root, abs).split(sep).join('/')
  const protect = (abs: string, by: string): void => {
    const rel = toRel(abs)
    if (rel !== null && !importedBy.has(rel)) importedBy.set(rel, by)
  }

  /** Files that load code in Node, with what to call them in a refusal. */
  const seeds: Array<{ readonly file: string; readonly by: string }> = []

  let appRoot = root
  try {
    appRoot = resolveAppRoot(root)
  } catch {
    // An unreadable profile leaves the project root as the one config folder.
  }
  for (const dir of new Set([root, appRoot])) {
    stamp(dir)
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names.filter(isHostConfigFileName)) {
      const file = join(dir, name)
      seeds.push({ file, by: shown(file) })
    }
  }

  stamp(join(appRoot, 'package.json'))
  const scriptConfig = devScriptConfig(appRoot)
  if (scriptConfig !== null) {
    protect(scriptConfig, 'the dev script (vite --config)')
    seeds.push({ file: scriptConfig, by: shown(scriptConfig) })
  }

  // Tailwind's CSS directives: each target is a seed of its own.
  stamp(join(root, 'package.json'))
  if (dependsOnTailwind(appRoot) || dependsOnTailwind(root)) {
    const dirs = new Set<string>()
    for (const rel of listWorkspaceFiles(root)) {
      const segments = rel.split('/')
      for (let i = 0; i < segments.length - 1; i += 1) dirs.add(segments.slice(0, i + 1).join('/'))
      if (!CSS_CARRIER.test(rel)) continue
      const css = join(root, ...segments)
      stamp(css)
      const text = readCapped(css)
      if (text === null) continue
      for (const { path: spec } of parseTailwindLoadDirectives(text)) {
        if (!spec.startsWith('./') && !spec.startsWith('../')) continue
        const by = `${rel} (@plugin/@config)`
        for (const candidate of candidatePaths(dirname(css), spec)) {
          protect(candidate, by)
          if (isFile(candidate)) seeds.push({ file: candidate, by })
        }
      }
    }
    for (const dir of dirs) stamp(join(root, ...dir.split('/')))
  }

  for (const seed of seeds) {
    let frontier = [seed.file]
    const seen = new Set<string>(frontier)
    for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
      const next: string[] = []
      for (const file of frontier) {
        if (!isFile(file)) continue
        stamp(file)
        // A symlinked module loads from where the link points: the target is
        // protected, and its imports resolve from ITS folder, as esbuild does.
        const real = realOrSelf(file)
        if (real !== file) {
          protect(real, seed.by)
          stamp(real)
        }
        const source = readCapped(real)
        if (source === null) continue
        for (const spec of relativeSpecifiers(source, real)) {
          for (const candidate of candidatePaths(dirname(real), spec)) {
            protect(candidate, seed.by)
            if (!seen.has(candidate) && isFile(candidate)) {
              seen.add(candidate)
              next.push(candidate)
            }
          }
        }
      }
      frontier = next
    }
  }
  return { importedBy, stamps }
}

/**
 * What loads `rel` in Node — a config file's name, or a stylesheet's
 * directive — or `null`. `root` and `rel` must be the same kind of path (both
 * real, or both textual): the gate asks once per pair.
 */
export function hostConfigImportedBy(root: string, rel: string): string | null {
  const key = resolve(root)
  let entry = cache.get(key)
  if (!entry || entry.stamps.some(([abs, mtime]) => mtimeOf(abs) !== mtime)) {
    entry = scan(key)
    cache.set(key, entry)
  }
  return entry.importedBy.get(comparableWorkspaceRel(rel)) ?? null
}

// ---------------------------------------------------------------------------
// Tailwind's load directives, read every way they can be read
// (security review of #256, B1 and its two re-reviews)
// ---------------------------------------------------------------------------

const BACKSLASH = 0x5c
const SLASH = 0x2f
const STAR = 0x2a
const QUOTE_DOUBLE = 0x22
const QUOTE_SINGLE = 0x27
const NEWLINE = 0x0a
const CARRIAGE_RETURN = 0x0d

/** A comment-stripped reading, and whether the tokenizer met a construct it could not close. */
interface StrippedReading {
  readonly text: string
  readonly unterminated: boolean
}

/**
 * `text` with its comments removed EXACTLY as Tailwind's own CSS parser
 * removes them — mirrored from `tailwindcss@4.3.3`'s `dist/lib.mjs`, the
 * parser function `Te(e, i)` (the one whose error reads "Unterminated
 * string"), and its string scanner `Lr(e, i, r, t)`:
 *
 * - a backslash escapes the next character EVERYWHERE — outside strings
 *   (`v===He` → `f+=e.slice(u,u+2),u+=1`, `He` = 92), inside comments
 *   (`m===He` → `y+=1`) and inside strings (`Lr`: `n===He` → `s+=1`). The
 *   escaped pair is kept, never interpreted: `x\'` is not a string opener;
 *   that miss was the second re-review's bypass;
 * - `/*` opens a comment that ends at the first unescaped `*\/`; the comment
 *   is dropped from the buffer with nothing in its place, which is why
 *   `@plu/**\/gin` becomes `@plugin`. An UNTERMINATED comment is not dropped:
 *   the loop leaves `u` on the `/` and the characters are read as text;
 * - `"` or `'` opens a string, copied whole, that ends at the same quote. A
 *   newline inside it makes Tailwind throw ("Unterminated string"); a string
 *   still open at the end of the text is NOT a string (`Lr` returns `i`, so
 *   only the quote is consumed) and reading goes on after the quote;
 * - `\r` before `\n` is skipped.
 *
 * Where Tailwind would throw — a newline inside a string — this reading does
 * what the CSS Syntax spec (§4.3.5, bad-string) does instead: it ends the
 * string there and carries on, so the rest of the file is still read (a
 * `.vue`'s `<script>` apostrophe must not hide its `<style>` block). Every
 * construct left open is reported as `unterminated`.
 */
function tailwindCommentStrip(text: string): StrippedReading {
  let out = ''
  let unterminated = false
  let u = 0
  while (u < text.length) {
    const code = text.charCodeAt(u)
    if (code === CARRIAGE_RETURN && text.charCodeAt(u + 1) === NEWLINE) { u += 1; continue }
    if (code === BACKSLASH) { out += text.slice(u, u + 2); u += 2; continue }
    if (code === SLASH && text.charCodeAt(u + 1) === STAR) {
      let end = -1
      for (let y = u + 2; y < text.length; y += 1) {
        const inner = text.charCodeAt(y)
        if (inner === BACKSLASH) { y += 1; continue }
        if (inner === STAR && text.charCodeAt(y + 1) === SLASH) { end = y + 1; break }
      }
      if (end === -1) { unterminated = true; out += '/'; u += 1; continue }
      u = end + 1
      continue
    }
    if (code === QUOTE_DOUBLE || code === QUOTE_SINGLE) {
      let end = -1
      let s = u + 1
      for (; s < text.length; s += 1) {
        const inner = text.charCodeAt(s)
        if (inner === BACKSLASH) { s += 1; continue }
        if (inner === code) { end = s; break }
        if (inner === NEWLINE) { unterminated = true; end = s - 1; break }
      }
      if (end === -1) { unterminated = true; out += text[u]; u += 1; continue }
      out += text.slice(u, end + 1)
      u = end + 1
      continue
    }
    out += text[u]
    u += 1
  }
  return { text: out, unterminated }
}

/** `text` with every `/*…*\/` removed, whatever quotes or escapes surround it. */
function naiveCommentStrip(text: string): StrippedReading {
  let out = ''
  let index = 0
  for (;;) {
    const open = text.indexOf('/*', index)
    if (open === -1) return { text: out + text.slice(index), unterminated: false }
    out += text.slice(index, open)
    const close = text.indexOf('*/', open + 2)
    if (close === -1) return { text: out, unterminated: true }
    index = close + 2
  }
}

/** CSS escapes decoded (`\70` → `p`, `\p` → `p`), the form a CSS-aware tool may compare a name in. */
function decodeCssEscapes(text: string): string {
  return text.replace(/\\([0-9a-fA-F]{1,6})[ \t\n]?|\\([^\n0-9a-fA-F])/g, (_all, hex: string | undefined, char: string | undefined) => {
    if (hex === undefined) return char ?? ''
    const point = parseInt(hex, 16)
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ''
  })
}

/** A `@plugin`/`@config` at-rule: its name, its parameter as written, and the path Tailwind takes from it. */
export interface TailwindLoadDirective {
  readonly name: '@plugin' | '@config'
  readonly params: string
  readonly path: string
}

/** A directive whose name was assembled from pieces — present, but with no parameter this reading can trust. */
const OBFUSCATED = '<spelled across comments or escapes>'
/** A reading that could not be closed, in a text that spells a directive somewhere: counted as one, fail closed. */
const UNTOKENIZABLE = '<in text a tokenizer could not close>'

/**
 * Every Tailwind `@plugin` / `@config` at-rule in a text, read every way it
 * can be read, so no spelling one tool sees and another misses slips
 * through (security review of #256, B1 and two re-reviews). Four readings
 * of the text — as written, comment-stripped the way Tailwind strips
 * (`tailwindCommentStrip`), comment-stripped naively, and each with CSS
 * escapes decoded — and in each, any `@plugin`/`@config` token up to the `;`,
 * `{` or `}` that ends it, however the path is wrapped (Tailwind takes it as
 * `params.slice(1, -1)`). On top, a letters-only pass over each reading
 * counts a name spelled across comments, escapes or whitespace
 * (`@plu/**\/gin`, `@\70 lu/**\/gin`) even where no parameter can be read.
 * And a reading that cannot be closed — an unterminated string or comment —
 * in a text that spells a directive anywhere counts as one more: fail closed.
 *
 * Over-counting is the safe side: the content gate refuses only a write that
 * ADDS to this list, so a directive every reading counts in both the old and
 * new text never refuses, and an over-count costs the user one approval.
 */
export function parseTailwindLoadDirectives(text: string): TailwindLoadDirective[] {
  const tokenized = tailwindCommentStrip(text)
  const naive = naiveCommentStrip(text)
  const readings = [text, tokenized.text, naive.text]
  const out: TailwindLoadDirective[] = []
  let spelled = 0
  for (const reading of readings) {
    for (const variant of [reading, decodeCssEscapes(reading)]) {
      out.push(...directivesIn(variant))
      const letters = variant.replace(/[^A-Za-z0-9@_-]/g, '')
      for (const match of letters.matchAll(/@(plugin|config)(?![A-Za-z0-9_-])/gi)) {
        spelled += 1
        out.push({ name: match[1]!.toLowerCase() === 'plugin' ? '@plugin' : '@config', params: OBFUSCATED, path: '' })
      }
    }
  }
  if ((tokenized.unterminated || naive.unterminated) && spelled > 0) {
    out.push({ name: '@plugin', params: UNTOKENIZABLE, path: '' })
  }
  return out
}

function directivesIn(text: string): TailwindLoadDirective[] {
  const out: TailwindLoadDirective[] = []
  for (const match of text.matchAll(/@(plugin|config)(?![\w-])([^;{}]{0,2000})/g)) {
    const params = match[2]!.trim()
    out.push({ name: match[1] === 'plugin' ? '@plugin' : '@config', params, path: params.length >= 2 ? params.slice(1, -1) : '' })
  }
  return out
}

/**
 * Every load directive in a text, each spelled as one comparable string
 * (`@plugin (./x.js)`, whitespace collapsed) — what the content gate diffs
 * before against after.
 */
export function tailwindLoadDirectives(text: string): string[] {
  return parseTailwindLoadDirectives(text).map(({ name, params }) => `${name} ${params.replace(/\s+/g, ' ')}`.trimEnd())
}
