/**
 * studioInstanceOverrideCommits — the two one-shot writes behind OD-19's
 * "editing a value inside a shared component changes ONLY that instance":
 *
 *   - {@link commitStudioInstanceOverride} — `expose-prop`: each changed value
 *     of an element inside a component becomes an optional prop of that
 *     component whose DEFAULT is the old value, and this one call site passes
 *     the new one. Two files, one gesture, one undo-journal entry — ⌘Z is the
 *     journal's `restore`, byte for byte.
 *   - {@link commitStudioPromoteOverride} — `promote-override`, the toast's
 *     "Apply to all (N)": the override becomes the component's default and the
 *     call site stops passing it. Journaled the same way.
 *
 * Both ride `commitStructural` (`studioStructuralCommitEngine.ts`): the
 * autosave is flushed first, the answer is read per edit, and the board
 * re-reads the two files once a write lands. What a REFUSAL means is the
 * caller's (`instanceOverrideActions.ts` falls back to the ordinary write for
 * the first, and the engine's own warning covers the second), which is why the
 * first is `quiet`.
 */
import type { OptimisticPreviewHandle } from '@site/store/slices/site/structuralOptimism'
import { commitStructural } from './studioStructuralCommitEngine'
import type { StudioSaveResponse } from './studioSaveRequests'

/** One value of the element and the prop it travels through — `ExposeOverrideSchema` on the wire. */
export interface InstanceOverrideWire {
  target: { kind: 'text' } | { kind: 'attribute'; name: string } | { kind: 'style'; property: string }
  propName: string
  value: string | number | boolean
}

export interface InstanceOverrideHooks {
  /** The canvas preview of the new values: kept until the write lands, taken back when it does not. */
  optimistic: OptimisticPreviewHandle
  /** The server's answer, as it arrives (again for the one silent re-plan after `element-moved`). */
  onAnswer: (answer: StudioSaveResponse) => void
  /** The board has re-read the two files the write changed. */
  onLanded: () => void
}

export async function commitStudioInstanceOverride(
  edit: { nodeId: string; overrides: readonly InstanceOverrideWire[] },
  label: string,
  hooks: InstanceOverrideHooks,
): Promise<void> {
  await commitStructural([{ kind: 'expose-prop', nodeId: edit.nodeId, overrides: edit.overrides.map((override) => ({ ...override })) }], 'Could not change this instance', {
    undo: { label, template: { kind: 'restore-journal' } },
    optimistic: hooks.optimistic,
    onAnswer: hooks.onAnswer,
    onLanded: hooks.onLanded,
    // The caller answers a refusal itself: it falls back to the ordinary
    // write, or says why nothing was written.
    quiet: true,
  })
}

export async function commitStudioPromoteOverride(edit: { nodeId: string; propNames: readonly string[] }, label: string): Promise<void> {
  await commitStructural([{ kind: 'promote-override', nodeId: edit.nodeId, propNames: [...edit.propNames] }], 'Could not apply to every instance', {
    undo: { label, template: { kind: 'restore-journal' } },
  })
}

/** What `expose-class` carries on the wire: one stylesheet rule's new declarations, for the instance whose root `nodeId` is. */
export interface ClassOverrideWire {
  file: string
  selector: string
  declarations: Readonly<Record<string, string>>
  atRule?: string
}

/**
 * G-2b - `expose-class`: a class-styled value edited inside one instance. The
 * instance's call site takes a modifier class, the component's root takes the
 * `className`, and the stylesheet gains a rule one class more specific. Three
 * files, one gesture, one journal entry. A refusal is the caller's to answer
 * (it falls back to the ordinary write), so it is `quiet`.
 */
export async function commitStudioClassOverride(edit: { nodeId: string } & ClassOverrideWire, label: string, hooks: InstanceOverrideHooks): Promise<void> {
  await commitStructural(
    [{ kind: 'expose-class', nodeId: edit.nodeId, file: edit.file, selector: edit.selector, declarations: { ...edit.declarations }, ...(edit.atRule !== undefined ? { atRule: edit.atRule } : {}) }],
    'Could not change this instance',
    { undo: { label, template: { kind: 'restore-journal' } }, optimistic: hooks.optimistic, onAnswer: hooks.onAnswer, onLanded: hooks.onLanded, quiet: true },
  )
}

/** G-2b - "Apply to all (N)" for a class override: the instance's values go into the component's own rule and the modifier goes. */
export async function commitStudioPromoteClassOverride(edit: { nodeId: string; file: string; selector: string; properties: readonly string[]; atRule?: string }, label: string): Promise<void> {
  await commitStructural(
    [{ kind: 'promote-class-override', nodeId: edit.nodeId, file: edit.file, selector: edit.selector, properties: [...edit.properties], ...(edit.atRule !== undefined ? { atRule: edit.atRule } : {}) }],
    'Could not apply to every instance',
    { undo: { label, template: { kind: 'restore-journal' } } },
  )
}
