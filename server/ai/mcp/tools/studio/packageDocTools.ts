/**
 * Reading a dependency's own documentation — the parts of it that matter.
 *
 * A design system documents itself in files far too large to read: the
 * Almosafer package ships `CLAUDE.md` at 103,147 bytes (~30,300 tokens) and
 * `design.md` at 106,076 (~31,200). Both individually exceed the CLI `Read`
 * tool's 25,000-token ceiling, so **every attempt to read either has always
 * failed** — 209 KB of component APIs and usage guidance that the agent has
 * never once seen. It was designing against a system whose rules it could not
 * open, which is exactly why generated screens used 2 of 42 components and
 * ignored the house style.
 *
 * Raising a cap would not fix that: 30k tokens of markdown to answer "what
 * props does Button take" is the wrong shape regardless of whether it fits.
 * Markdown is already structured, so this tool addresses it by that structure:
 *
 *   - `outline: true`  → every heading, with byte sizes. Cheap, a few hundred
 *                        tokens for a 100 KB file, and enough to choose.
 *   - `section: "Button"` → just that heading's body.
 *   - neither          → the outline plus the head of the document.
 *
 * The whole file is never returned, so no input can produce an oversized
 * result. That is the point: the failure mode being fixed is a read that
 * cannot succeed, and a tool that can still be asked for 30k tokens would
 * simply reproduce it.
 *
 * ## Why this is not `studio_read_file`
 *
 * `studio_read_file` is containment-checked to the project directory, and
 * deliberately so — it is the tool an agent uses on the USER'S source. A
 * dependency lives in `node_modules`, frequently hoisted to a workspace root
 * ABOVE the project (which is exactly the case here: the package resolves from
 * the repo root, not from the project). Widening that containment to reach it
 * would weaken the guard protecting the user's own files for the sake of
 * reading documentation.
 *
 * So this is a separate, narrower door: markdown only, from an installed
 * package's own directory, read-only, never the whole file.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { Type } from '@core/utils/typeboxHelpers'
import type { AiTool } from '../../../runtime/types'
import { resolveProjectDir } from '../../../../handlers/studioProjects'

/** Markdown only. A dependency's docs are the use case; its source is not. */
const ALLOWED_DOC_PATTERN = /^[A-Za-z0-9._-]+\.md$/

/** Cap on a single section's body — a pathological heading cannot blow the turn. */
const MAX_SECTION_BYTES = 40_000
/** Head-of-document preview when no section was named. */
const MAX_PREVIEW_BYTES = 4_000
/** How far up the tree to look for a hoisted `node_modules`. */
const MAX_PARENT_HOPS = 8

const PackageDocInputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the first project under studio-workspace/.' }),
    ),
    package: Type.String({
      description: 'Installed package name, e.g. "@alm-design/design-system".',
    }),
    doc: Type.Optional(
      Type.String({ description: 'Markdown file in the package root. Defaults to CLAUDE.md.' }),
    ),
    outline: Type.Optional(
      Type.Boolean({ description: 'Return every heading with its size, and no body. Start here.' }),
    ),
    section: Type.Optional(
      Type.String({ description: 'Heading to return the body of. Matched case-insensitively, exact heading first, then prefix.' }),
    ),
  },
  { additionalProperties: false },
)

interface DocSection {
  heading: string
  level: number
  body: string
}

/**
 * Resolve `<package>/<doc>` from the project upward, so a dependency hoisted to
 * a workspace root resolves the same as a locally-installed one. Returns null
 * unless the resolved path really sits inside that package's own directory —
 * a `doc` of `../../.env` must not escape, and the name pattern alone is not
 * where that guarantee should live.
 */
function resolvePackageDoc(projectDir: string, packageName: string, doc: string): string | null {
  if (!ALLOWED_DOC_PATTERN.test(doc)) return null
  // A package name is `name` or `@scope/name` — nothing else may reach a path.
  if (!/^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(packageName)) return null

  let current = resolve(projectDir)
  for (let hop = 0; hop <= MAX_PARENT_HOPS; hop++) {
    const packageDir = join(current, 'node_modules', ...packageName.split('/'))
    if (existsSync(packageDir)) {
      const file = resolve(packageDir, doc)
      // Containment: the doc must live inside the package directory itself.
      if (!file.startsWith(resolve(packageDir) + sep)) return null
      if (!existsSync(file) || !statSync(file).isFile()) return null
      return file
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

/** Split markdown on ATX headings. Content before the first heading becomes the "(intro)" section. */
function splitSections(markdown: string): DocSection[] {
  const lines = markdown.split('\n')
  const sections: DocSection[] = []
  let heading = '(intro)'
  let level = 0
  let body: string[] = []

  const flush = (): void => {
    const text = body.join('\n').trim()
    if (heading !== '(intro)' || text.length > 0) sections.push({ heading, level, body: text })
  }

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line)
    if (match) {
      flush()
      level = match[1]!.length
      heading = match[2]!.trim()
      body = []
      continue
    }
    body.push(line)
  }
  flush()
  return sections
}

/** Exact heading match first, then a prefix match — "Button" should find "Button" before "ButtonGroup". */
function findSection(sections: DocSection[], wanted: string): DocSection | null {
  const needle = wanted.trim().toLowerCase()
  const exact = sections.find((s) => s.heading.toLowerCase() === needle)
  if (exact) return exact
  return sections.find((s) => s.heading.toLowerCase().startsWith(needle)) ?? null
}

function clip(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  return {
    text: Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8'),
    truncated: true,
  }
}

const packageDocTool: AiTool = {
  name: 'studio_read_package_doc',
  scope: 'shared',
  execution: 'server',
  description:
    'Read an installed dependency\'s own markdown documentation (CLAUDE.md, design.md, README.md) BY SECTION. These files routinely exceed the plain-Read size limit — a design system\'s reference can be 100 KB+, so reading it whole always fails; this is how to actually get at it. Call with outline:true first to see every heading and its size, then call again with section:"<heading>" for just the part you need. Resolves the package from the project upward, so a hoisted node_modules works. Markdown files in the package root only; the whole file is never returned. Returns { ok:false, error } when the package or doc is not installed.',
  inputSchema: PackageDocInputSchema,
  handler: async (input) => {
    const { dir: dirInput, package: packageName, doc: docInput, outline, section } = input as {
      dir?: string
      package: string
      doc?: string
      outline?: boolean
      section?: string
    }
    const dir = resolveProjectDir(dirInput)
    const doc = docInput ?? 'CLAUDE.md'

    const file = resolvePackageDoc(dir, packageName, doc)
    if (!file) {
      return { ok: false, error: `"${packageName}/${doc}" is not an installed markdown doc reachable from this project.` }
    }

    let markdown: string
    try {
      markdown = readFileSync(file, 'utf8')
    } catch (err) {
      return { ok: false, error: `Could not read "${packageName}/${doc}": ${err instanceof Error ? err.message : String(err)}` }
    }

    const sections = splitSections(markdown)
    const totalBytes = Buffer.byteLength(markdown, 'utf8')
    const headings = sections.map((s) => ({
      heading: s.heading,
      level: s.level,
      bytes: Buffer.byteLength(s.body, 'utf8'),
    }))

    if (outline) {
      return { ok: true, package: packageName, doc, totalBytes, sectionCount: sections.length, headings }
    }

    if (section) {
      const found = findSection(sections, section)
      if (!found) {
        return {
          ok: false,
          error: `No section matching "${section}" in ${packageName}/${doc}.`,
          headings: headings.map((h) => h.heading),
        }
      }
      const clipped = clip(found.body, MAX_SECTION_BYTES)
      return {
        ok: true,
        package: packageName,
        doc,
        heading: found.heading,
        level: found.level,
        content: clipped.text,
        ...(clipped.truncated ? { truncated: true } : {}),
      }
    }

    // Neither: the outline plus a head-of-document preview, so one blind call
    // still returns something useful and something navigable.
    const preview = clip(markdown, MAX_PREVIEW_BYTES)
    return {
      ok: true,
      package: packageName,
      doc,
      totalBytes,
      sectionCount: sections.length,
      headings,
      preview: preview.text,
      note: 'Whole-file reads are never returned. Call again with section:"<heading>" for a specific part.',
    }
  },
}

export const studioPackageDocMcpTools: AiTool[] = [packageDocTool]
