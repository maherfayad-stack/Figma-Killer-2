/**
 * The refusal a tool call gets when its arguments do not match the tool's
 * input schema (AI-27).
 *
 * `executeAiTool` validates every raw argument object against the tool's
 * TypeBox `inputSchema` before dispatch. It used to hand the model TypeBox's
 * own assertion text on failure — "Expected union value", "Expected required
 * property" — which names neither WHICH field nor WHAT shape was wanted. A
 * strong model re-reads the schema and recovers; a small one guesses, and the
 * observed shape of that guess is the same malformed call again.
 *
 * So a schema failure answers three questions, in the `error` text every
 * driver forwards to the model:
 *
 *   1. **where** — the JSON-pointer path of each failing field (`/pages/0`),
 *      with `(root)` for the arguments object itself;
 *   2. **what was expected** there, described from the schema node that
 *      failed (`one of "light" | "dark"`, `string (at least 1 character)`,
 *      `array of string (at most 20 items)`), and what arrived instead;
 *   3. **a minimal valid call** — the required fields only, each with a value
 *      its schema accepts. The example is CHECKED against the schema before it
 *      is offered, and omitted when no honest one can be built (a `pattern`
 *      string, say): an example that itself fails validation would be a
 *      second wrong answer delivered with more confidence than the first.
 *
 * It is a coded refusal (`input-schema-mismatch`, not retryable — the same
 * arguments fail the same way), so the chat path also carries `issues` and
 * `example` as structured fields.
 */
import type { TSchema } from '@sinclair/typebox'
import type { ValueError } from '@sinclair/typebox/errors'
import { compiled } from '@core/utils/typeboxHelpers'
import { toolRefusal, type ToolRefusal } from '@core/ai'

/** How many failing fields one refusal names. The first few are what the model can act on; a wall of them is noise. */
const MAX_ISSUES = 3
/** Longest rendered example. The required fields of every real tool fit far inside this. */
const MAX_EXAMPLE_CHARS = 600
/** Recursion bound for both the describer and the example builder — schemas here are shallow, a pathological one must not recurse forever. */
const MAX_DEPTH = 6

interface ToolInputIssue {
  /** JSON pointer into the arguments, `(root)` for the object itself. */
  readonly path: string
  /** What the schema wanted at that path. */
  readonly expected: string
  /** What arrived there instead. */
  readonly received: string
}

/** The loose view of a JSON-Schema node this module reads. TypeBox schemas ARE JSON Schema, so no cast hides a different shape. */
interface SchemaNode {
  readonly type?: string | readonly string[]
  readonly const?: unknown
  readonly enum?: readonly unknown[]
  readonly anyOf?: readonly SchemaNode[]
  readonly items?: SchemaNode
  readonly properties?: Readonly<Record<string, SchemaNode>>
  readonly required?: readonly string[]
  readonly minLength?: number
  readonly maxLength?: number
  readonly pattern?: string
  readonly format?: string
  readonly minimum?: number
  readonly maximum?: number
  readonly exclusiveMinimum?: number
  readonly exclusiveMaximum?: number
  readonly minItems?: number
  readonly maxItems?: number
  readonly default?: unknown
}

/**
 * Build the refusal for a call whose arguments failed `inputSchema`.
 *
 * `failure` is whatever `parseValue` threw. TypeBox's `AssertError` carries
 * the errors against the value AFTER its clean/default/convert pipeline, which
 * is what actually failed; anything else falls back to validating the raw
 * arguments, which names the same fields.
 */
export function toolInputRefusal(
  toolName: string,
  schema: TSchema,
  rawInput: unknown,
  failure: unknown,
): ToolRefusal & Record<string, unknown> {
  const issues = collectIssues(schema, rawInput, failure)
  const example = minimalValidExample(schema)
  const where = issues.length > 0
    ? issues.map((issue) => `at ${issue.path} expected ${issue.expected}, got ${issue.received}`).join('; ')
    : 'the arguments failed validation'
  const exampleJson = example === undefined ? undefined : JSON.stringify(example)
  return toolRefusal('input-schema-mismatch', `The arguments do not match ${toolName}'s input schema: ${where}.`, {
    remedy: exampleJson === undefined
      ? 'Fix the named fields and call it again.'
      : `Fix the named fields and call it again. A minimal valid call (required fields only) is ${exampleJson}.`,
    details: { issues, ...(example === undefined ? {} : { example }) },
  })
}

function collectIssues(schema: TSchema, rawInput: unknown, failure: unknown): ToolInputIssue[] {
  const errors: ValueError[] = []
  const fromFailure = assertErrors(failure)
  for (const error of fromFailure ?? compiled(schema).Errors(rawInput)) {
    errors.push(error)
    if (errors.length >= 20) break
  }
  const seen = new Set<string>()
  const issues: ToolInputIssue[] = []
  for (const error of errors) {
    const path = error.path === '' ? '(root)' : error.path
    // TypeBox can report several errors at one path (a type AND a bound, say).
    // The issue names the schema node, which already states all of them.
    if (seen.has(path)) continue
    seen.add(path)
    issues.push({
      path,
      expected: describeSchema(error.schema as SchemaNode, 0),
      received: describeValue(error.value),
    })
    if (issues.length >= MAX_ISSUES) break
  }
  return issues
}

/** `AssertError.Errors()` when `failure` is one, else `null`. Structural, so no dependency on TypeBox's class identity across bundles. */
function assertErrors(failure: unknown): Iterable<ValueError> | null {
  if (typeof failure !== 'object' || failure === null) return null
  const candidate = failure as { Errors?: unknown }
  if (typeof candidate.Errors !== 'function') return null
  return (candidate.Errors as () => Iterable<ValueError>).call(failure)
}

/** One line saying what a schema node accepts. */
function describeSchema(schema: SchemaNode, depth: number): string {
  if (depth > MAX_DEPTH) return 'a value'
  if (schema.const !== undefined) return JSON.stringify(schema.const)
  if (schema.enum && schema.enum.length > 0) return `one of ${schema.enum.map((v) => JSON.stringify(v)).join(' | ')}`
  if (schema.anyOf && schema.anyOf.length > 0) {
    if (schema.anyOf.every((member) => member.const !== undefined)) {
      return `one of ${schema.anyOf.map((member) => JSON.stringify(member.const)).join(' | ')}`
    }
    return schema.anyOf.map((member) => describeSchema(member, depth + 1)).join(' or ')
  }
  const type = typeof schema.type === 'string' ? schema.type : schema.type?.join(' or ')
  switch (type) {
    case 'string':
      return `string${bounds(
        schema.minLength !== undefined ? `at least ${schema.minLength} character${schema.minLength === 1 ? '' : 's'}` : null,
        schema.maxLength !== undefined ? `at most ${schema.maxLength} characters` : null,
        schema.format !== undefined ? `format ${schema.format}` : null,
        schema.pattern !== undefined ? `matching /${schema.pattern}/` : null,
      )}`
    case 'number':
    case 'integer':
      return `${type}${bounds(
        schema.minimum !== undefined ? `>= ${schema.minimum}` : schema.exclusiveMinimum !== undefined ? `> ${schema.exclusiveMinimum}` : null,
        schema.maximum !== undefined ? `<= ${schema.maximum}` : schema.exclusiveMaximum !== undefined ? `< ${schema.exclusiveMaximum}` : null,
      )}`
    case 'array':
      return `array of ${schema.items ? describeSchema(schema.items, depth + 1) : 'values'}${bounds(
        schema.minItems !== undefined ? `at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}` : null,
        schema.maxItems !== undefined ? `at most ${schema.maxItems} items` : null,
      )}`
    case 'object': {
      const required = schema.required ?? []
      return required.length > 0 ? `object with required ${required.join(', ')}` : 'object'
    }
    case undefined:
      return 'a value'
    default:
      return type
  }
}

function bounds(...parts: Array<string | null>): string {
  const present = parts.filter((part): part is string => part !== null)
  return present.length > 0 ? ` (${present.join(', ')})` : ''
}

/** What actually arrived, briefly — a type plus a short rendering, never a whole payload. */
function describeValue(value: unknown): string {
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return `an array of ${value.length}`
  if (typeof value === 'object') return 'an object'
  const rendered = JSON.stringify(value) ?? String(value)
  const short = rendered.length > 40 ? `${rendered.slice(0, 40)}…` : rendered
  return `${typeof value} ${short}`
}

/**
 * The smallest arguments object `schema` accepts: required fields only, each
 * with a value its own node accepts. `undefined` when none can be built, or
 * when the one built does not actually validate — see the module doc.
 */
function minimalValidExample(schema: TSchema): unknown {
  const example = exampleFor(schema as SchemaNode, null, 0)
  if (example === NO_EXAMPLE) return undefined
  if (!compiled(schema).Check(example)) return undefined
  const json = JSON.stringify(example)
  return json !== undefined && json.length <= MAX_EXAMPLE_CHARS ? example : undefined
}

const NO_EXAMPLE = Symbol('no-example')

function exampleFor(schema: SchemaNode, key: string | null, depth: number): unknown {
  if (depth > MAX_DEPTH) return NO_EXAMPLE
  if (schema.default !== undefined) return schema.default
  if (schema.const !== undefined) return schema.const
  if (schema.enum && schema.enum.length > 0) return schema.enum[0]
  if (schema.anyOf) {
    for (const member of schema.anyOf) {
      if (member.type === 'null') continue
      const candidate = exampleFor(member, key, depth + 1)
      if (candidate !== NO_EXAMPLE) return candidate
    }
    return NO_EXAMPLE
  }
  const type = typeof schema.type === 'string' ? schema.type : schema.type?.[0]
  switch (type) {
    case 'string': {
      let text = key ? `<${key}>` : '<text>'
      if (schema.minLength !== undefined) while (text.length < schema.minLength) text += '_'
      if (schema.maxLength !== undefined) text = text.slice(0, schema.maxLength)
      return text
    }
    case 'number':
    case 'integer': {
      const low = schema.minimum ?? (schema.exclusiveMinimum !== undefined ? schema.exclusiveMinimum + 1 : 0)
      const high = schema.maximum ?? (schema.exclusiveMaximum !== undefined ? schema.exclusiveMaximum - 1 : low)
      return Math.min(low, high)
    }
    case 'boolean':
      return false
    case 'null':
      return null
    case 'array': {
      const count = schema.minItems ?? 0
      if (count === 0) return []
      if (!schema.items) return NO_EXAMPLE
      const item = exampleFor(schema.items, key, depth + 1)
      return item === NO_EXAMPLE ? NO_EXAMPLE : Array.from({ length: count }, () => item)
    }
    case 'object': {
      const out: Record<string, unknown> = {}
      for (const name of schema.required ?? []) {
        const property = schema.properties?.[name]
        if (!property) return NO_EXAMPLE
        const value = exampleFor(property, name, depth + 1)
        if (value === NO_EXAMPLE) return NO_EXAMPLE
        out[name] = value
      }
      return out
    }
    default:
      return NO_EXAMPLE
  }
}
