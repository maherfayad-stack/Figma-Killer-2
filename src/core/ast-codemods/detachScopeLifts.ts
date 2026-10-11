/**
 * detachScopeLifts - the two ways detach brings a name the component's file
 * owns into the page without inlining it where it is read (G-3):
 *
 *  - **hoist a body value** (`hoistLocal`): a `const` the markup reads twice,
 *    inside a callback, or builds from another body value is computed ONCE at
 *    the top of the page's component, under a fresh name;
 *  - **carry a module-scope helper** (`carryDeclaration`): a function or pure
 *    constant the component's file declares and does not export is copied into
 *    the page's module scope, so the markup can read it.
 *
 * Both write the thing in terms of the PAGE - the same rewriting the markup
 * gets, which is why the planner hands its own `renderNode`/`componentValue` in
 * - and both refuse by name (`body-local`, `unbound-reference`, `name-collision`)
 * where doing it would change what runs, or what a name means. Plans only;
 * `detachComponent.ts` writes, and its gate checks every name still binds.
 * Split out of `detachPlanner.ts` at the module-size ceiling.
 */
import { Node, VariableDeclarationKind, type SourceFile, type VariableDeclaration } from 'ts-morph'
import type { DetachNameResolver } from './detachNames'
import type { Unit } from './detachConditionals'
import type { PageTextEdit } from './detachHooks'
import { isPureInitializer } from './detachPurity'
import { fail, type Value } from './detachSource'

export interface ScopeLiftDeps {
  page: SourceFile
  componentFile: SourceFile
  componentName: string
  names: DetachNameResolver
  /** The planner's own rewriting of a node for the page. */
  renderNode: (node: Node, unit: Unit) => string
  componentValue: (node: Node) => Value
  /** Writes `const <fresh> = <initializer>` at the top of the page's component; answers the name. */
  emitLocal: (preferred: string, initializer: string) => string
}

export class ScopeLifts {
  private readonly deps: ScopeLiftDeps
  private readonly hoisted = new Map<VariableDeclaration, Value>()
  /** Declarations carried into the page's module scope, by the component file's declaration. */
  private readonly carried = new Map<Node, string>()
  private readonly carriedText: { name: string; text: string }[] = []

  constructor(deps: ScopeLiftDeps) {
    this.deps = deps
  }

  private get page(): SourceFile {
    return this.deps.page
  }
  private get componentFile(): SourceFile {
    return this.deps.componentFile
  }
  private get componentName(): string {
    return this.deps.componentName
  }
  private get names(): DetachNameResolver {
    return this.deps.names
  }

  /**
   * The value of a body `const` computed once in the page: the initializer is
   * written in terms of the page (its props are the call site's values, its
   * hooks and other body values are hoisted first, so statements come out in
   * dependency order) and emitted as `const <fresh> = ...`. Refused, `body-local`,
   * when the initializer could do something by being computed early
   * (`detachPurity.ts`), or reads a name only the call site's own scope has.
   */
  hoistLocal(decl: VariableDeclaration): Value {
    const cached = this.hoisted.get(decl)
    if (cached) return cached
    const name = decl.getName()
    const initializer = decl.getInitializerOrThrow()
    if (!isPureInitializer(initializer)) {
      fail(
        'body-local',
        `${this.componentName} computes \`${name}\` in its body with a call detach cannot move without running it earlier than it was meant to run. Duplicate the component and edit the copy instead.`,
      )
    }
    const written = this.deps.componentValue(initializer)
    for (const read of written.free) {
      if (this.names.expected.get(read)?.has('call-site')) {
        fail(
          'body-local',
          `${this.componentName} computes \`${name}\` from a value this call site passes (\`${read}\`), which the page's component may not have yet. Duplicate the component and edit the copy.`,
        )
      }
    }
    const local = this.deps.emitLocal(name, written.expr())
    this.names.expect(local, 'hook')
    const value: Value = { expr: () => local, primary: true, free: new Set([local]) }
    this.hoisted.set(decl, value)
    return value
  }

  /**
   * A helper the component's file declares at module level and does not export
   * (`CopyIcon`, `SPONSORED`, `BottomSheetShell`) is copied into the page's own
   * module scope, so the detached markup can read it. Never exported from the
   * component's file instead: that file may be Studio's (`design-system/`), and
   * even a user's own is not ours to edit for a detach.
   *
   * What may be copied is what has no life of its own: a function, or a `const`
   * whose initializer is pure (`detachPurity.ts`) - a second copy is the same
   * value, or the same component rendering the same markup. Its own names are
   * written for the page exactly like the markup's (imports planned, further
   * private helpers carried first, so declarations come out in dependency
   * order). A page that already declares the name with the same text (an
   * earlier detach of the same component) reuses it; with different text the
   * name is not ours to take, and detach refuses `name-collision`.
   */
  carryDeclaration(name: string, decl: Node): string {
    const done = this.carried.get(decl)
    if (done !== undefined) return done
    const statement = Node.isVariableDeclaration(decl) ? decl.getVariableStatement() : decl
    const copyable =
      (Node.isFunctionDeclaration(decl) && decl.getName() === name) ||
      (Node.isVariableDeclaration(decl) &&
        decl.getVariableStatement()?.getDeclarationKind() === VariableDeclarationKind.Const &&
        decl.getVariableStatement()?.getDeclarations().length === 1 &&
        Node.isIdentifier(decl.getNameNode()) &&
        decl.getInitializer() !== undefined &&
        isPureInitializer(decl.getInitializerOrThrow()))
    if (!statement || !copyable) {
      fail(
        'unbound-reference',
        `${this.componentName}'s markup reads \`${name}\`, which ${this.componentFile.getBaseName()} declares but does not export, and detach cannot copy it. Export it from its file.`,
      )
    }
    // Registered first: a helper that reads itself, or a cycle of helpers, finds its own name.
    this.carried.set(decl, name)
    const text = this.deps.renderNode(statement, { node: statement, free: new Set() })
    const existing = this.page.getFunction(name)?.getText() ?? this.page.getVariableDeclaration(name)?.getVariableStatement()?.getText()
    if (existing !== undefined) {
      if (existing.replace(/\s+/g, '') === text.replace(/\s+/g, '')) {
        this.names.expect(name, 'module')
        return name
      }
      fail('name-collision', `${this.componentName} reads its own \`${name}\`, and this page already declares a different \`${name}\`. Rename the page's \`${name}\`.`)
    }
    if (!this.names.isNameAvailable(name, name)) {
      fail('name-collision', `${this.componentName} reads its own \`${name}\`, and this page already uses that name for something else. Rename the page's \`${name}\`.`)
    }
    this.names.reserve(name)
    this.carriedText.push({ name, text })
    return name
  }

  /** The one text edit that writes every carried declaration: after the page's imports (and its directive), before its own code. */
  carriedDeclarationsEdit(): PageTextEdit | undefined {
    if (this.carriedText.length === 0) return undefined
    const last = this.page.getImportDeclarations().at(-1)
    const directive = this.page.getStatements().filter((statement) => Node.isExpressionStatement(statement) && Node.isStringLiteral(statement.getExpression())).at(-1)
    const anchor = last ?? directive
    const body = this.carriedText.map((entry) => entry.text).join('\n\n')
    return anchor ? { pos: anchor.getEnd(), remove: 0, text: '\n\n' + body } : { pos: 0, remove: 0, text: body + '\n\n' }
  }
}
