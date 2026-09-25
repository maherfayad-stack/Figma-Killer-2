/**
 * SelectionStyleCommandHost — runs the style writes queued in
 * `selectionStyleCommands.ts` through the inspector's own model and commit
 * API, so a key press, a menu item or a canvas handle writes exactly where
 * the inspector would (see that module for why this is a queue).
 *
 * Renders nothing, and mounts the (costly) selection model only while a
 * command is waiting.
 */
import { useLayoutEffect } from 'react'
import { useInspectorCommit } from '@site/inspector/commitApi'
import { useSelectionModel } from '@site/inspector/selectionModel'
import {
  settleSelectionStyleCommands,
  usePendingSelectionStyleCommands,
  type SelectionStyleCommand,
} from './selectionStyleCommands'

/**
 * Every command ever run, so a re-render that reaches the effect again before
 * the queue has settled can never run one twice.
 */
const alreadyRan = new WeakSet<SelectionStyleCommand>()

export function SelectionStyleCommandHost() {
  const pending = usePendingSelectionStyleCommands()
  if (pending.length === 0) return null
  return <SelectionStyleCommandRunner commands={pending} />
}

function SelectionStyleCommandRunner({ commands }: { commands: readonly SelectionStyleCommand[] }) {
  const model = useSelectionModel()
  const commit = useInspectorCommit(model)
  // A live (bridge) frame answers the computed-style read asynchronously; the
  // write target depends on it (which source already sets the property), so
  // wait for the answer rather than guess.
  const ready = !model.computedValuesLoading

  // Layout effect, not a passive one: a command may clear a canvas preview
  // just before it commits (the padding handles do), and the store update it
  // makes must re-render before the browser paints, or the old value shows
  // for one frame between the two.
  useLayoutEffect(() => {
    if (!ready) return
    try {
      for (const command of commands) {
        if (alreadyRan.has(command)) continue
        alreadyRan.add(command)
        command(commit, model)
      }
    } catch (err) {
      console.error('[SelectionStyleCommandHost] style command failed:', err)
    } finally {
      settleSelectionStyleCommands(commands)
    }
  }, [commands, ready, commit, model])

  return null
}
