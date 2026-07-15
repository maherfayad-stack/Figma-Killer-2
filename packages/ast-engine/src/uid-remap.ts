/**
 * uidRemap computation (ADR-0018 item 4): "old→new NodeUid for every
 * SURVIVING node whose astPath shifts due to the op (insert/delete/move
 * shift sibling indices; wrap adds a parent level). Deleted nodes are
 * absent."
 *
 * DESIGN NOTE (why this is pure string/index math, not a tree diff): an
 * empirical check (`ts-morph` `SourceFile#insertText`/manipulation APIs)
 * showed that `Node` wrapper OBJECT IDENTITY is NOT preserved across a
 * structural manipulation for descendants of the changed subtree — every
 * previously-held reference under the touched parent gets "forgotten"
 * (ts-morph reparses that region). Rather than depend on identity survival,
 * this module recomputes the shift ANALYTICALLY from the astPath algorithm
 * itself (`uid-path.ts`): astPath is *purely* a function of (a) which
 * ancestor a node's chain passes through and (b) its ordinal sibling
 * position under that ancestor. Every one of the 4 structural ops
 * (insert/delete/move/wrap) only ever changes ordinal positions under ONE
 * or TWO known ancestors — knowable from the op's own parameters before any
 * mutation happens — so the remap can be computed directly against the
 * PRE-image astPath list, with no need to re-derive or diff a post-image
 * tree at all.
 *
 * SCOPE LIMITATION (flagged, not silently dropped): a target whose OWN
 * astPath has no dot (a file ROOT, `d<n>`) has no "parent ancestor" in this
 * scheme — deleting/moving a root would, per the babel algorithm, also
 * renumber every subsequent root (`d2` -> `d1` etc.), which this module
 * does not attempt to cascade. Realistic canvas ops always target nodes
 * nested under the frame's root element, never the root itself, so this is
 * an acceptable, explicitly-flagged gap rather than a silent one.
 */

export type AstPathRemap = Map<string, string>;

interface AncestorSplit {
  siblingIndex: number;
  /** Everything after the sibling-index segment, INCLUDING the leading
   * `.` if present (empty string for a direct child with no descendants
   * of its own listed separately). Preserved byte-for-byte across a shift
   * — only the sibling-index segment itself ever changes. */
  suffix: string;
}

function splitAtAncestor(astPath: string, ancestorAstPath: string): AncestorSplit | null {
  const prefix = `${ancestorAstPath}.`;
  if (!astPath.startsWith(prefix)) return null;
  const rest = astPath.slice(prefix.length);
  const dot = rest.indexOf('.');
  if (dot === -1) return { siblingIndex: Number(rest), suffix: '' };
  return { siblingIndex: Number(rest.slice(0, dot)), suffix: rest.slice(dot) };
}

function joinAtAncestor(ancestorAstPath: string, siblingIndex: number, suffix: string): string {
  return `${ancestorAstPath}.${siblingIndex}${suffix}`;
}

export interface ParentAndIndex {
  parentAstPath: string;
  index: number;
}

/** Split a NON-ROOT astPath into its parent's astPath + this node's
 * ordinal sibling index under that parent. Throws for a root astPath
 * (no dot) — see the scope limitation above. */
export function parentAndIndexOf(astPath: string): ParentAndIndex {
  const lastDot = astPath.lastIndexOf('.');
  if (lastDot === -1) {
    throw new Error(
      `@ccs/ast-engine: astPath "${astPath}" is a file root — delete/move of a root node's ` +
        'sibling-shift is not supported (see uid-remap.ts scope limitation)',
    );
  }
  return { parentAstPath: astPath.slice(0, lastDot), index: Number(astPath.slice(lastDot + 1)) };
}

/** A new sibling was inserted under `ancestorAstPath` at `atIndex`
 * (`count` new siblings, default 1) — every existing path-node whose
 * direct-child index under that ancestor was `>= atIndex` shifts up by
 * `count`, cascading unchanged into its own descendants' suffix. */
export function shiftForInsertion(
  preEntries: readonly string[],
  ancestorAstPath: string,
  atIndex: number,
  count = 1,
): AstPathRemap {
  const remap: AstPathRemap = new Map();
  for (const astPath of preEntries) {
    const split = splitAtAncestor(astPath, ancestorAstPath);
    if (!split) continue;
    if (split.siblingIndex >= atIndex) {
      remap.set(astPath, joinAtAncestor(ancestorAstPath, split.siblingIndex + count, split.suffix));
    }
  }
  return remap;
}

/** `count` siblings (default 1) were removed under `ancestorAstPath`
 * starting at `atIndex` — those siblings (and all their descendants) are
 * OMITTED (they don't survive); every sibling after the removed range
 * shifts down by `count`. */
export function shiftForRemoval(
  preEntries: readonly string[],
  ancestorAstPath: string,
  atIndex: number,
  count = 1,
): AstPathRemap {
  const remap: AstPathRemap = new Map();
  for (const astPath of preEntries) {
    const split = splitAtAncestor(astPath, ancestorAstPath);
    if (!split) continue;
    if (split.siblingIndex >= atIndex && split.siblingIndex < atIndex + count) continue; // removed
    if (split.siblingIndex >= atIndex + count) {
      remap.set(astPath, joinAtAncestor(ancestorAstPath, split.siblingIndex - count, split.suffix));
    }
  }
  return remap;
}

/** Every path-node at or under `oldPrefix` (an exact astPath, e.g. a moved
 * subtree's root) gets that PREFIX portion rewritten to `newPrefix`,
 * leaving the rest of the chain (relative internal structure) untouched —
 * used when a subtree survives but its ancestor chain changes (a move's
 * own subtree, or a wrap's wrapped children gaining one nesting level). */
export function rewritePrefix(
  preEntries: readonly string[],
  oldPrefix: string,
  newPrefix: string,
): AstPathRemap {
  const remap: AstPathRemap = new Map();
  for (const astPath of preEntries) {
    if (astPath === oldPrefix) {
      remap.set(astPath, newPrefix);
    } else if (astPath.startsWith(`${oldPrefix}.`)) {
      remap.set(astPath, `${newPrefix}${astPath.slice(oldPrefix.length)}`);
    }
  }
  return remap;
}

function mergeRemaps(...maps: AstPathRemap[]): AstPathRemap {
  const out: AstPathRemap = new Map();
  for (const map of maps) {
    for (const [oldPath, newPath] of map) out.set(oldPath, newPath);
  }
  return out;
}

/** Unique direct-child sibling indices observed under `ancestorAstPath`
 * across the pre-image entries (used to simulate a same-parent reorder as
 * an array splice). */
function collectDirectChildIndices(preEntries: readonly string[], ancestorAstPath: string): number[] {
  const indices = new Set<number>();
  for (const astPath of preEntries) {
    const split = splitAtAncestor(astPath, ancestorAstPath);
    if (split) indices.add(split.siblingIndex);
  }
  return [...indices].sort((a, b) => a - b);
}

// ---- per-op composition -----------------------------------------------

export function insertNodeRemap(
  preEntries: readonly string[],
  parentAstPath: string,
  index: number,
): AstPathRemap {
  return shiftForInsertion(preEntries, parentAstPath, index);
}

export function deleteNodeRemap(preEntries: readonly string[], targetAstPath: string): AstPathRemap {
  const { parentAstPath, index } = parentAndIndexOf(targetAstPath);
  return shiftForRemoval(preEntries, parentAstPath, index);
}

export function moveNodeRemap(
  preEntries: readonly string[],
  targetAstPath: string,
  newParentAstPath: string,
  newIndex: number,
): AstPathRemap {
  const { parentAstPath: oldParentAstPath, index: oldIndex } = parentAndIndexOf(targetAstPath);

  if (oldParentAstPath === newParentAstPath) {
    // Same-parent reorder: simulate the array splice directly rather than
    // composing separate remove/insert shifts (which would double-shift).
    const siblingIndices = collectDirectChildIndices(preEntries, oldParentAstPath);
    const withoutMoved = siblingIndices.filter((i) => i !== oldIndex);
    const clampedNewIndex = Math.max(0, Math.min(newIndex, withoutMoved.length));
    const finalOrder = [
      ...withoutMoved.slice(0, clampedNewIndex),
      oldIndex,
      ...withoutMoved.slice(clampedNewIndex),
    ];

    const indexRemap = new Map<number, number>();
    finalOrder.forEach((originalIndex, newPosition) => {
      if (originalIndex !== newPosition) indexRemap.set(originalIndex, newPosition);
    });

    const remap: AstPathRemap = new Map();
    for (const astPath of preEntries) {
      const split = splitAtAncestor(astPath, oldParentAstPath);
      if (!split) continue;
      const mapped = indexRemap.get(split.siblingIndex);
      if (mapped !== undefined) {
        remap.set(astPath, joinAtAncestor(oldParentAstPath, mapped, split.suffix));
      }
    }
    return remap;
  }

  const removal = shiftForRemoval(preEntries, oldParentAstPath, oldIndex);
  const insertion = shiftForInsertion(preEntries, newParentAstPath, newIndex);
  const movedSubtree = rewritePrefix(
    preEntries,
    targetAstPath,
    joinAtAncestor(newParentAstPath, newIndex, ''),
  );
  return mergeRemaps(removal, insertion, movedSubtree);
}

/** `wrappedIndices` MUST be the sorted, contiguous direct-child sibling
 * indices (under `parentAstPath`) of the nodes being wrapped — the
 * `wrap-node` op's uids after resolution, per ADR-0018/Appendix B
 * (`wrapper.tag` frozen to `div`). The wrapped nodes survive one level
 * deeper (under the new wrapper, itself at the first wrapped index);
 * later siblings shift down by `wrappedIndices.length - 1` (N nodes
 * replaced by 1 wrapper). */
export function wrapNodeRemap(
  preEntries: readonly string[],
  parentAstPath: string,
  wrappedIndices: readonly number[],
): AstPathRemap {
  const startIndex = wrappedIndices[0]!;
  const count = wrappedIndices.length;
  const remap: AstPathRemap = new Map();

  for (const astPath of preEntries) {
    const split = splitAtAncestor(astPath, parentAstPath);
    if (!split) continue;

    if (split.siblingIndex >= startIndex && split.siblingIndex < startIndex + count) {
      const localIndex = split.siblingIndex - startIndex;
      remap.set(astPath, `${parentAstPath}.${startIndex}.${localIndex}${split.suffix}`);
    } else if (split.siblingIndex >= startIndex + count && count > 1) {
      // count===1: N=1 node "replaced by" 1 wrapper is not a size change,
      // so later siblings don't shift — no entry (old === new).
      remap.set(astPath, joinAtAncestor(parentAstPath, split.siblingIndex - (count - 1), split.suffix));
    }
  }

  return remap;
}

/**
 * The inverse of `wrapNodeRemap` — used by `invertOp`'s `unwrap-node`
 * (ast-engine's own extension for wrap-node's inverse, see `invert-op.ts`):
 * the wrapper at `parentAstPath.wrapperIndex` (with `childCount` direct
 * children) is removed, its children rise one level to become direct
 * children of `parentAstPath` again (taking over indices
 * `wrapperIndex..wrapperIndex+childCount-1`), and later siblings of the
 * (removed) wrapper shift DOWN by `childCount - 1`.
 */
export function unwrapNodeRemap(
  preEntries: readonly string[],
  parentAstPath: string,
  wrapperIndex: number,
  childCount: number,
): AstPathRemap {
  const remap: AstPathRemap = new Map();
  const wrapperAstPath = `${parentAstPath}.${wrapperIndex}`;
  const wrapperChildPrefix = `${wrapperAstPath}.`;

  for (const astPath of preEntries) {
    if (astPath === wrapperAstPath) continue; // the wrapper itself does not survive

    if (astPath.startsWith(wrapperChildPrefix)) {
      const rest = astPath.slice(wrapperChildPrefix.length);
      const dot = rest.indexOf('.');
      const localIndex = Number(dot === -1 ? rest : rest.slice(0, dot));
      const suffix = dot === -1 ? '' : rest.slice(dot);
      remap.set(astPath, `${parentAstPath}.${wrapperIndex + localIndex}${suffix}`);
      continue;
    }

    const split = splitAtAncestor(astPath, parentAstPath);
    if (split && split.siblingIndex > wrapperIndex) {
      remap.set(astPath, joinAtAncestor(parentAstPath, split.siblingIndex + (childCount - 1), split.suffix));
    }
  }

  return remap;
}
 