import type { PluginObj } from '@babel/core';
import type { NodePath } from '@babel/traverse';
import type * as t from '@babel/types';
import { createUidPathTracker } from './uid-path.js';
import { isDynamicJsxNode } from './dynamic.js';
import { resolveComponentTag } from './component-resolution.js';

export const DATA_UID_ATTR = 'data-uid';
export const DATA_DYNAMIC_ATTR = 'data-dynamic';
export const DATA_COMPONENT_ATTR = 'data-component';

interface BabelApi {
  types: typeof t;
}

/**
 * `createSourceUidBabelPlugin(relPath)` — one Babel plugin FACTORY CALL per
 * file transform (see `transform.ts`), not a singleton reused across files.
 * This is a deliberate design choice: a fresh call captures a fresh
 * `UidPathTracker` (and closes over that file's `relPath`) in its closure,
 * so there is no cross-file state to reset via Babel's `Program.enter` /
 * `PluginPass` lifecycle — the simplest possible way to guarantee each
 * file's root/child counters start at zero.
 *
 * Tags every `JSXElement`/`JSXFragment` per the editable-surface contract
 * (playbook §0) and ADR-0016:
 *  - `data-uid="<relPath>:<astPath>"` (JSXElement only — see the
 *    JSXFragment deviation note below).
 *  - `data-dynamic="true"` when inside a `.map()`/other CallExpression
 *    callback, ternary, or logical (`&&`/`||`) expression.
 *  - `data-component="<tag>"` (`ds:`-prefixed for design-system imports)
 *    when the tag resolves to an imported component.
 */
export function createSourceUidBabelPlugin(relPath: string) {
  return function sourceUidBabelPlugin({ types: t }: BabelApi): PluginObj {
    const tracker = createUidPathTracker();

    return {
      name: 'ccs-source-uid',
      visitor: {
        JSXElement: {
          enter(path: NodePath<t.JSXElement>) {
            const astPath = tracker.pathFor(path);
            const uid = `${relPath}:${astPath}`;
            const dynamic = isDynamicJsxNode(path);

            const openingElementPath = path.get('openingElement');
            const attributes: t.JSXAttribute[] = [
              t.jsxAttribute(t.jsxIdentifier(DATA_UID_ATTR), t.stringLiteral(uid)),
            ];

            if (dynamic) {
              attributes.push(
                t.jsxAttribute(t.jsxIdentifier(DATA_DYNAMIC_ATTR), t.stringLiteral('true')),
              );
            }

            const resolved = resolveComponentTag(openingElementPath);
            if (resolved) {
              const value = resolved.fromDesignSystem ? `ds:${resolved.name}` : resolved.name;
              attributes.push(
                t.jsxAttribute(t.jsxIdentifier(DATA_COMPONENT_ATTR), t.stringLiteral(value)),
              );
            }

            path.node.openingElement.attributes.push(...attributes);
          },
        },
        JSXFragment: {
          enter(path: NodePath<t.JSXFragment>) {
            // DEVIATION (called out in the worker report): shorthand
            // `<>...</>` fragments have no `openingElement`/attribute list
            // in the AST, and `React.Fragment` forwards no props to the DOM
            // even written out explicitly — there is no DOM node to carry a
            // `data-uid`. We still register the fragment in the tracker (so
            // sibling numbering for its JSX children/neighbors stays
            // deterministic regardless of whether a given root/branch
            // happens to be a fragment) but emit no attribute.
            tracker.pathFor(path);
          },
        },
      },
    };
  };
}
