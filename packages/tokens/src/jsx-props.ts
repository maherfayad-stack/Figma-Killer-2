import {
  Project,
  SyntaxKind,
  type Node,
  type ParameterDeclaration,
  type ObjectBindingPattern,
  type SourceFile,
} from 'ts-morph';

/**
 * `extractDestructuredProps` — reads a `design-system/src/components/
 * <Name>.jsx` file's SOURCE TEXT and returns the prop names its exported
 * component destructures from its first parameter (`function X({a, b,
 * ...rest})`, `const X = ({a, b}) => ...`, or the `forwardRef(function
 * X({a, b}, ref) => ...)` wrapper all three real-world shapes used across
 * the 39 components). PURE — no execution, ts-morph AST walk only,
 * matching `parseComponentMeta`'s "read the source, never run it"
 * discipline.
 *
 * Used by the ADR-0021 drift test: every authored `<Name>.meta.ts`'s
 * `props` keys MUST be a SUBSET of what this function returns for the
 * matching `<Name>.jsx` — catches a meta.ts drifting out of sync with a
 * future prop rename/removal in the real component.
 */
export function extractDestructuredProps(sourceText: string, componentName: string): string[] {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true },
  });
  const sourceFile = project.createSourceFile(`${componentName}.jsx`, sourceText);

  const firstParam = findComponentFirstParam(sourceFile, componentName);
  if (!firstParam) return [];
  const pattern = firstParam.getNameNode().asKind(SyntaxKind.ObjectBindingPattern);
  if (!pattern) return [];
  return bindingPatternNames(pattern);
}

function findComponentFirstParam(sourceFile: SourceFile, componentName: string): ParameterDeclaration | undefined {
  const fn = sourceFile.getFunction(componentName);
  if (fn) return fn.getParameters()[0];

  const varDecl = sourceFile.getVariableDeclaration(componentName);
  if (varDecl) {
    const init = varDecl.getInitializer();
    const direct = asFunctionLike(init);
    if (direct) return direct.getParameters()[0];
    const call = init?.asKind(SyntaxKind.CallExpression);
    if (call) {
      // forwardRef(function X({...}, ref) {...}) / memo(...) / any single
      // higher-order wrapper — scan its arguments for the actual function.
      for (const arg of call.getArguments()) {
        const fnArg = asFunctionLike(arg);
        if (fnArg) return fnArg.getParameters()[0];
      }
    }
  }
  return undefined;
}

function asFunctionLike(node: Node | undefined) {
  if (!node) return undefined;
  return node.asKind(SyntaxKind.ArrowFunction) ?? node.asKind(SyntaxKind.FunctionExpression);
}

function bindingPatternNames(pattern: ObjectBindingPattern): string[] {
  const names: string[] = [];
  for (const element of pattern.getElements()) {
    if (element.getDotDotDotToken()) continue; // `...rest` — not an individual prop
    const propertyNameNode = element.getPropertyNameNode();
    if (propertyNameNode) {
      const str = propertyNameNode.asKind(SyntaxKind.StringLiteral);
      names.push(str ? str.getLiteralValue() : propertyNameNode.getText());
    } else {
      names.push(element.getName());
    }
  }
  return names;
}
