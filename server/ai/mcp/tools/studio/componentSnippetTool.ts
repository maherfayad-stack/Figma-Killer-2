/**
 * `studio_component_snippet` — the exact import line and a JSX usage for one
 * design-system component, written for the file it is going into (AI-14).
 *
 * `studio_list_components` / `studio_find_component` say what exists. What an
 * agent still had to get right on its own, and routinely got wrong:
 *
 *   - **the import specifier.** For Studio's built-in design system it is a
 *     path RELATIVE to the importing file (`../design-system` from
 *     `pages/Home.tsx`, `../../design-system` from `src/pages/Home.tsx`); the
 *     catalog can only say "compute it". This computes it, with the same
 *     `designSystemImportSpecifier` the page scaffolder and the migration use.
 *   - **default vs named export**, which the catalog records and a model
 *     skims past.
 *   - **valid enum values.** A value outside a prop's declared set is refused
 *     here with the set, instead of shipping as a silent fallback to the
 *     component's default — the "size=default is 16px" class of bug, caught
 *     before the write instead of after the screenshot.
 *
 * Same catalog pass as the two catalog tools (`collectCatalog`), so the three
 * cannot disagree about what a component is called or what it accepts. A
 * read: it never writes, and `forFile` is only a location to compute a
 * specifier from (it need not exist; when it does, the result says whether
 * the component is already imported there).
 */
import { Type } from '@core/utils/typeboxHelpers'
import { toolRefusal } from '@core/ai'
import { designSystemImportSpecifier } from '@core/page-parser'
import type { AiTool, ToolContext } from '../../../runtime/types'
import { resolveToolProjectDir } from './resolveToolProjectDir'
import { collectCatalog, type CatalogEntry } from './componentCatalogTools'
import { AGENT_FILE_MAX_BYTES, pathRefusal } from './fileReadTools'
import { AGENT_PATH_MAX_CHARS, readTextFile, resolveAgentFilePath } from '../../../../handlers/studio/agentFileAccess'
import type { PropSpec } from '../../../../handlers/studio/packageManifestSchema'

type PropValue = string | number | boolean

const ComponentSnippetInputSchema = Type.Object(
  {
    dir: Type.Optional(
      Type.String({ description: 'Absolute project directory. Defaults to the project currently open in Studio — omit it unless you deliberately mean a DIFFERENT project than the one this conversation is about.' }),
    ),
    name: Type.String({ minLength: 1, maxLength: 120, description: 'The component name exactly as studio_list_components reports it, e.g. "Button".' }),
    forFile: Type.String({ minLength: 1, maxLength: AGENT_PATH_MAX_CHARS, description: 'The project-relative file the usage goes into, e.g. "pages/Checkout.tsx". It need not exist yet; the import is computed relative to it.' }),
    props: Type.Optional(
      Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]), {
        description: 'Prop values to put in the usage, e.g. { "variant": "primary", "size": "medium" }. Checked against the component\'s declared props: an enum value outside its set is refused with the set.',
      }),
    ),
    children: Type.Optional(Type.String({ maxLength: 400, description: 'Text content between the tags, e.g. the button label "Continue". Real copy, not lorem.' })),
    package: Type.Optional(Type.String({ description: 'Which package, when two installed packages both have a component of this name.' })),
  },
  { additionalProperties: false },
)

/** Every prop kind a literal value can be written for. `node`/`handler`/`unknown` take JSX or code, which the caller writes itself. */
const LITERAL_KINDS = new Set(['string', 'number', 'boolean', 'enum', 'color', 'image'])

function acceptedValues(spec: PropSpec): string {
  const kind = spec.kind
  if (kind.kind === 'enum') return kind.values.map((v) => `"${v}"`).join(' | ')
  return kind.kind
}

/** Why `value` cannot go into `spec`, or `null`. */
function valueProblem(spec: PropSpec, value: PropValue): string | null {
  const kind = spec.kind
  switch (kind.kind) {
    case 'enum':
      return typeof value === 'string' && kind.values.includes(value) ? null : `must be one of ${acceptedValues(spec)}`
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false'
    case 'number':
      return typeof value === 'number' ? null : 'must be a number'
    case 'string':
    case 'color':
    case 'image':
      return typeof value === 'string' ? null : 'must be a string'
    default:
      return `takes ${kind.kind === 'unknown' ? 'a value this catalog cannot describe' : kind.kind === 'node' ? 'JSX (an element)' : 'a function'}, so write it into the snippet yourself`
  }
}

function attribute(name: string, value: PropValue): string {
  if (value === true) return name
  if (typeof value === 'boolean' || typeof value === 'number') return `${name}={${String(value)}}`
  return /["{}<>\\]/.test(value) ? `${name}={${JSON.stringify(value)}}` : `${name}="${value}"`
}

function childText(text: string): string {
  return /[{}<>]/.test(text) ? `{${JSON.stringify(text)}}` : text
}

function importLine(entry: CatalogEntry, specifier: string): string {
  if (entry.isDefaultExport) return `import ${entry.name} from '${specifier}'`
  return entry.exportName === entry.name
    ? `import { ${entry.name} } from '${specifier}'`
    : `import { ${entry.exportName} as ${entry.name} } from '${specifier}'`
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Nearest catalog names to `name`, for a refusal — substring either way, then a shared first letter. */
function nearestNames(entries: readonly CatalogEntry[], name: string): string[] {
  const needle = name.toLowerCase()
  const names = [...new Set(entries.map((e) => e.name))]
  const close = names.filter((n) => n.toLowerCase().includes(needle) || needle.includes(n.toLowerCase()))
  const sameInitial = names.filter((n) => n[0]?.toLowerCase() === needle[0] && !close.includes(n))
  return [...close, ...sameInitial].slice(0, 8)
}

const componentSnippetTool: AiTool = {
  name: 'studio_component_snippet',
  scope: 'shared',
  execution: 'server',
  sideEffects: 'none',
  description:
    'Get the exact import line and a ready-to-paste JSX usage for one design-system component, for the file it goes into. The import specifier is computed relative to forFile for Studio\'s built-in design system (never write that path by hand), and follows the component\'s real default/named export. props are checked against the component\'s declared API: an enum value outside its set, a wrong type or an undeclared prop is refused with invalid-prop-value and the accepted values. Returns { import, jsx, alreadyImported, props (the full API with enum values), unfilledRequired }. Refuses no-such-component with the nearest names. A read; it writes nothing.',
  inputSchema: ComponentSnippetInputSchema,
  handler: async (input, ctx: ToolContext) => {
    const { dir: dirInput, name, forFile, props = {}, children, package: pkg } = input as {
      dir?: string
      name: string
      forFile: string
      props?: Record<string, PropValue>
      children?: string
      package?: string
    }
    const dir = resolveToolProjectDir(dirInput, ctx)

    const target = resolveAgentFilePath(dir, forFile, 'read')
    if (!target.ok) return pathRefusal(target)

    const { components } = collectCatalog(dir)
    const exact = components.filter((c) => c.name === name && (pkg === undefined || c.pkg === pkg))
    const matches = exact.length > 0 ? exact : components.filter((c) => c.name.toLowerCase() === name.toLowerCase() && (pkg === undefined || c.pkg === pkg))
    if (matches.length === 0) {
      const nearest = nearestNames(components, name)
      return toolRefusal('no-such-component', `No component "${name}"${pkg ? ` in ${pkg}` : ''} is in this project's design-system catalog.`, {
        remedy: nearest.length > 0 ? `Nearest names: ${nearest.join(', ')}.` : 'studio_list_components lists every component this project has; it may have none.',
        details: { nearest },
      })
    }
    if (matches.length > 1) {
      return toolRefusal('invalid-input', `"${name}" exists in ${matches.length} packages: ${matches.map((m) => m.pkg).join(', ')}.`, {
        remedy: 'Pass package to say which one.',
      })
    }
    const entry = matches[0]!

    const specByName = new Map(entry.props.map((p) => [p.name, p]))
    const attributes: string[] = []
    const warnings: string[] = []
    for (const [propName, value] of Object.entries(props)) {
      const spec = specByName.get(propName)
      if (!spec) {
        if (entry.apiSource === 'code-connect') {
          warnings.push(`${propName} is not in this component's Figma Code Connect mapping, which may be incomplete — check the package's own types before relying on it.`)
          attributes.push(attribute(propName, value))
          continue
        }
        return toolRefusal('invalid-prop-value', `${entry.name} does not declare a prop "${propName}".`, {
          remedy: `Its props: ${entry.props.map((p) => p.name).join(', ') || '(none)'}.`,
        })
      }
      const problem = valueProblem(spec, value)
      if (problem) {
        return toolRefusal('invalid-prop-value', `${entry.name}'s ${propName} ${problem}; got ${JSON.stringify(value)}.`, {
          remedy: `Pass ${acceptedValues(spec)}.`,
          details: { prop: propName, accepted: spec.kind.kind === 'enum' ? spec.kind.values : spec.kind.kind },
        })
      }
      attributes.push(attribute(propName, value))
    }

    const unfilledRequired = entry.props
      .filter((p) => p.required && !(p.name in props) && !(p.name === 'children' && children !== undefined))
      .map((p) => ({ name: p.name, kind: p.kind.kind, ...(p.kind.kind === 'enum' ? { values: p.kind.values } : {}), literal: LITERAL_KINDS.has(p.kind.kind) }))

    const open = [entry.name, ...attributes].join(' ')
    const jsx = children !== undefined ? `<${open}>${childText(children)}</${entry.name}>` : `<${open} />`
    const specifier = entry.apiSource === 'builtin' ? designSystemImportSpecifier(target.rel) : entry.pkg
    const importText = importLine(entry, specifier)

    let alreadyImported: boolean | null = null
    const existing = readTextFile(target.abs, AGENT_FILE_MAX_BYTES)
    if (existing.kind === 'text') {
      const binding = entry.isDefaultExport ? entry.name : entry.exportName
      alreadyImported = new RegExp(`import\\s[^;]*\\b${escapeRegExp(binding)}\\b[^;]*from\\s*['"]${escapeRegExp(specifier)}['"]`).test(existing.content)
    }

    return {
      ok: true,
      dir,
      component: { name: entry.name, pkg: entry.pkg, apiSource: entry.apiSource, ...(entry.description ? { description: entry.description } : {}) },
      forFile: target.rel,
      import: importText,
      ...(alreadyImported === null ? {} : { alreadyImported }),
      jsx,
      props: entry.props.map((p) => ({ name: p.name, kind: p.kind.kind, required: p.required, ...(p.kind.kind === 'enum' ? { values: p.kind.values } : {}) })),
      ...(unfilledRequired.length > 0 ? { unfilledRequired, complete: false } : { complete: true }),
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  },
}

export const studioComponentSnippetMcpTools: AiTool[] = [componentSnippetTool]
